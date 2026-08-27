const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { buildUninstallScript } = require("../src/lib/uninstall");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "manager-uninstall-test-"));
  const installRoot = join(root, "platform");
  const fakeBin = join(root, "bin");
  const sourceInstaller = join(root, "latest-installer");
  const marker = join(root, "marker");
  mkdirSync(join(installRoot, "state"), { recursive: true });
  mkdirSync(join(installRoot, "installer", "lib"), { recursive: true });
  mkdirSync(join(sourceInstaller, "lib"), { recursive: true });
  mkdirSync(fakeBin);
  writeFileSync(join(installRoot, "state", "installer-state.json"), JSON.stringify({ sourceRepository: "https://github.com/example/private.git", sourceRef: "main" }));
  writeFileSync(join(installRoot, "installer", "install.sh"), `#!/bin/sh\necho stale > ${JSON.stringify(marker)}\n`);
  writeFileSync(join(installRoot, "installer", "lib", "uninstall.sh"), "# stale uninstall library\n");
  writeFileSync(join(sourceInstaller, "install.sh"), `#!/bin/sh\necho latest > ${JSON.stringify(marker)}\n`);
  writeFileSync(join(sourceInstaller, "lib", "uninstall.sh"), "# latest uninstall library\n");
  chmodSync(join(sourceInstaller, "install.sh"), 0o755);

  writeFileSync(join(fakeBin, "docker"), `#!/bin/sh\nif [ "$1" = inspect ]; then exit 0; fi\nprintf '%s' 'github_pat_TEST_SECRET_12345678901234567890'\n`);
  writeFileSync(join(fakeBin, "git"), `#!/bin/sh
printf '%s\\n' "$@" >> "$GIT_ARGS_FILE"
last=""
helper=""
for value in "$@"; do
  last="$value"
  case "$value" in credential.helper=*) helper="\${value#credential.helper=}" ;; esac
done
if [ "\${FAIL_GIT:-0}" = 1 ]; then exit 42; fi
[ -z "$helper" ] || "$helper" get > "$CREDENTIAL_CAPTURE"
mkdir -p "$last/installer"
cp -R "$FAKE_SOURCE_INSTALLER/." "$last/installer/"
`);
  chmodSync(join(fakeBin, "docker"), 0o755);
  chmodSync(join(fakeBin, "git"), 0o755);

  return {
    root,
    installRoot,
    marker,
    script: buildUninstallScript({}, { installRoot }),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_SOURCE_INSTALLER: sourceInstaller,
      GIT_ARGS_FILE: join(root, "git-args"),
      CREDENTIAL_CAPTURE: join(root, "credential-capture")
    }
  };
}

test("refreshes a stale installer, preserves executable mode, and runs the latest copy", () => {
  const item = fixture();
  const result = spawnSync("bash", ["-c", item.script], { encoding: "utf8", env: item.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(item.marker, "utf8").trim(), "latest");
  assert.notEqual(statSync(join(item.installRoot, "installer", "install.sh")).mode & 0o111, 0);
  assert.match(readFileSync(join(item.installRoot, "installer", "lib", "uninstall.sh"), "utf8"), /latest uninstall library/);
  assert.match(readFileSync(item.env.GIT_ARGS_FILE, "utf8"), /credential\.helper=.*git-credential-helper\.sh/);
  assert.match(readFileSync(item.env.CREDENTIAL_CAPTURE, "utf8"), /password=github_pat_TEST_SECRET/);
  assert.doesNotMatch(result.stdout + result.stderr, /github_pat_TEST_SECRET/);
});

test("refresh failure prevents stale uninstall from starting", () => {
  const item = fixture();
  const result = spawnSync("bash", ["-c", item.script], { encoding: "utf8", env: { ...item.env, FAIL_GIT: "1" } });
  assert.notEqual(result.status, 0);
  assert.equal(spawnSync("test", ["-e", item.marker]).status, 1);
  assert.match(result.stderr, /Could not refresh the Deployment Platform uninstaller from the configured source\. Uninstall was not started\./);
});

test("private credential resolver never embeds a token in commands or generated logs", () => {
  const script = buildUninstallScript();
  assert.match(script, /resolveGithubToken/);
  assert.match(script, /credential\.helper=/);
  assert.doesNotMatch(script, /github_pat_|ghp_/);
  assert.doesNotMatch(script, /set -x/);
});

test("credential-bearing source URLs are rejected without logging the credential", () => {
  const item = fixture();
  const secret = "github_pat_URL_SECRET_12345678901234567890";
  writeFileSync(join(item.installRoot, "state", "installer-state.json"), JSON.stringify({
    sourceRepository: `https://${secret}@github.com/example/private.git`,
    sourceRef: "main"
  }));
  const result = spawnSync("bash", ["-c", item.script], { encoding: "utf8", env: item.env });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  assert.match(result.stderr, /Uninstall was not started/);
});

test("destructive uninstall flags retain the existing explicit confirmation contract without stdin piping", () => {
  const script = buildUninstallScript({ purgeAll: true, confirmPhrase: "DELETE EVERYTHING", deleteSecrets: true });
  assert.match(script, /--purge-all --confirm-purge/);
  assert.match(script, /--delete-secrets/);
  assert.doesNotMatch(script, /printf .*\| bash/);
});
