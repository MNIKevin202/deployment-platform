const test = require("node:test");
const assert = require("node:assert/strict");
const {
  initialStages,
  parseStatus,
  redactSecrets,
  updateStagesFromOutput,
  validateInstallInput
} = require("../src/lib/core");

test("validateInstallInput accepts password authentication and confirms admin password", () => {
  const input = validateInstallInput({
    host: "46.202.178.170",
    sshUser: "root",
    sshPassword: "server-password",
    panelDomain: "deploy.example.com",
    appsDomain: "apps.example.com",
    adminUsername: "admin",
    adminPassword: "long-password",
    adminPasswordConfirm: "long-password",
    repository: "https://github.com/MNIKevin202/deployment-platform.git",
    sourceRef: "main"
  });
  assert.equal(input.authMethod, "password");
  assert.equal(input.enableAutoUpdates, true);
});

test("validateInstallInput rejects mismatched administrator passwords", () => {
  assert.throws(
    () => validateInstallInput({
      host: "host.example.com",
      sshUser: "root",
      sshPassword: "server-password",
      panelDomain: "deploy.example.com",
      appsDomain: "apps.example.com",
      adminUsername: "admin",
      adminPassword: "long-password",
      adminPasswordConfirm: "different-password",
      repository: "https://github.com/MNIKevin202/deployment-platform.git",
      sourceRef: "main"
    }),
    /passwords do not match/i
  );
});

test("validateInstallInput validates the environment export password", () => {
  const base = {
    host: "host.example.com", sshUser: "root", sshPassword: "server-password",
    panelDomain: "deploy.example.com", appsDomain: "apps.example.com", adminUsername: "admin",
    adminPassword: "long-password", adminPasswordConfirm: "long-password",
    repository: "https://github.com/MNIKevin202/deployment-platform.git", sourceRef: "main"
  };
  assert.throws(
    () => validateInstallInput({ ...base, environmentExportPassword: "short", environmentExportPasswordConfirm: "short" }),
    /export password must be at least 12/i
  );
  assert.throws(
    () => validateInstallInput({ ...base, environmentExportPassword: "export-password-123", environmentExportPasswordConfirm: "different-password" }),
    /export passwords do not match/i
  );
});

test("redactSecrets removes explicit secrets, tokens, and terminal control codes", () => {
  const output = redactSecrets(
    "\u001b[31mpassword=super-secret token: ghp_abc123 SESSION_SECRET=abc\u001b[0m",
    ["super-secret"]
  );
  assert.equal(output.includes("super-secret"), false);
  assert.equal(output.includes("ghp_abc123"), false);
  assert.equal(output.includes("\u001b"), false);
});

test("updateStagesFromOutput advances stages from real output", () => {
  const stages = updateStagesFromOutput(initialStages(), "SSH connection established\n===== SOURCE =====");
  assert.equal(stages[0].status, "done");
  assert.equal(stages[6].status, "done");
  assert.equal(stages[7].status, "active");
});

test("parseStatus extracts container image and state summaries", () => {
  const parsed = parseStatus("__DP_INSTALLED__=true\ndeployment-platform-api deployment-platform-api:0.1.1 running\ndeployment-platform-web deployment-platform-web:0.1.1 exited");
  assert.equal(parsed.installed, true);
  assert.equal(parsed.api.image, "deployment-platform-api:0.1.1");
  assert.equal(parsed.api.state, "running");
  assert.equal(parsed.web.state, "exited");
});

test("parseStatus distinguishes an uninstalled VPS", () => {
  assert.equal(parseStatus("__DP_INSTALLED__=false\n").installed, false);
  assert.equal(parseStatus("").installed, null);
});

test("parseStatus extracts token-free GitHub status", () => {
  const parsed = parseStatus('{"connected":true,"username":"MNIKevin202","lastValidatedAt":"2026-08-27T00:00:00Z","credentialStatus":"connected"}');
  assert.equal(parsed.github.connected, true);
  assert.equal(parsed.github.username, "MNIKevin202");
});

test("long progress status gets a stable long-text class", () => {
  const { progressStatusClass } = require("../src/lib/core");
  assert.equal(progressStatusClass("Reading package lists... 99%"), "");
  assert.equal(progressStatusClass("x".repeat(120)), "long");
});

test("profile storage excludes the GitHub token", () => {
  const input = validateInstallInput({
    host: "host.example.com", sshUser: "root", sshPassword: "server-password",
    panelDomain: "deploy.example.com", appsDomain: "apps.example.com", adminUsername: "admin",
    adminPassword: "long-password", adminPasswordConfirm: "long-password",
    repository: "https://github.com/MNIKevin202/deployment-platform.git", sourceRef: "main",
    githubToken: "github_pat_fake_secret"
  });
  assert.equal(input.githubToken, "github_pat_fake_secret");
  assert.equal(require("../src/lib/core").buildProfile(input).githubToken, undefined);
});

test("GitHub capability test validates private contents with mocked API", async () => {
  const { testGithubToken } = require("../src/lib/github");
  const calls = [];
  const responses = {
    "/user": { login: "MNIKevin202" },
    "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member": [{ full_name: "MNIKevin202/private-app", owner: { login: "MNIKevin202" }, name: "private-app", private: true, default_branch: "main" }],
    "/repos/MNIKevin202/private-app": {},
    "/repos/MNIKevin202/private-app/git/ref/heads/main": {},
    "/repos/MNIKevin202/private-app/contents/?ref=main": []
  };
  const result = await testGithubToken({ githubToken: "github_pat_fake_secret", githubRepository: "MNIKevin202/private-app" }, async (url) => {
    const path = new URL(url).pathname + (new URL(url).search || "");
    calls.push(path);
    return { ok: true, status: 200, json: async () => responses[path] };
  });
  assert.equal(result.success, true);
  assert.equal(result.privateAccess, true);
  assert.equal(result.contentsAccess, true);
  assert.equal(calls.length, 5);
});

test("GitHub capability test distinguishes invalid and insufficient tokens", async () => {
  const { testGithubToken } = require("../src/lib/github");
  const response = (status) => async () => ({ ok: false, status, json: async () => ({}) });
  assert.match((await testGithubToken({ githubToken: "github_pat_fake" }, response(401))).message, /invalid or expired/i);
  assert.match((await testGithubToken({ githubToken: "github_pat_fake" }, response(403))).message, /denied this capability/i);
});

test("manager requires final confirmation before starting uninstall", () => {
  const { readFileSync } = require("node:fs");
  const renderer = readFileSync(require.resolve("../src/renderer/renderer.js"), "utf8");
  const handler = renderer.slice(renderer.indexOf('$("#run-uninstall").addEventListener'), renderer.indexOf("window.installer.onLog"));
  assert.match(handler, /window\.confirm\("Are you sure you want to uninstall Deployment Platform from this VPS\?"\)/);
  assert.ok(handler.indexOf("window.confirm") < handler.indexOf("window.installer.uninstall"));
});

test("manager hides management options when the platform is not installed", () => {
  const { readFileSync } = require("node:fs");
  const renderer = readFileSync(require.resolve("../src/renderer/renderer.js"), "utf8");
  assert.match(renderer, /renderInstallationState\(result\.status\.installed\)/);
  assert.match(renderer, /installed-options.*classList\.toggle\("hidden", !installed\)/s);
  assert.match(renderer, /not-installed-view.*classList\.toggle\("hidden", installed !== false\)/s);
});

test("installer transfers GitHub credentials without a PTY and bounds the transfer time", () => {
  const { readFileSync } = require("node:fs");
  const main = readFileSync(require.resolve("../src/main.js"), "utf8");
  assert.match(main, /\{ pty: options\.pty !== false \}/);
  assert.match(main, /\{ pty: false, timeoutMs: 30000 \}/);
  assert.match(main, /cat > \$\{shellQuote\(tokenPath\)\}/);
  assert.doesNotMatch(main, /install -m 600 \/dev\/stdin/);
});

test("initial source clone uses the temporary GitHub credential helper", () => {
  const { readFileSync } = require("node:fs");
  const main = readFileSync(require.resolve("../src/main.js"), "utf8");
  assert.match(main, /credential\.helper=\$credential_helper/);
  assert.match(main, /cat "\$GITHUB_TOKEN_FILE"/);
  assert.match(main, /git "\\\$\{git_auth\[@\]\}" clone/);
});

test("installer and manager scripts run without a PTY so completion closes SSH", () => {
  const { readFileSync } = require("node:fs");
  const main = readFileSync(require.resolve("../src/main.js"), "utf8");
  const installHandler = main.slice(main.indexOf('ipcMain.handle("install:start"'), main.indexOf('ipcMain.handle("server:status"'));
  const runRemote = main.slice(main.indexOf("async function runRemote"), main.indexOf("function connectionConfig"));
  assert.match(installHandler, /installInput[\s\S]*\{ pty: false \}/);
  assert.match(runRemote, /transport\.run\([\s\S]*\}, \{ pty: false \}\)/);
});
