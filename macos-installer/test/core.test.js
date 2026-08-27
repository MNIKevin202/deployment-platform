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
  const parsed = parseStatus("deployment-platform-api deployment-platform-api:0.1.1 running\ndeployment-platform-web deployment-platform-web:0.1.1 exited");
  assert.equal(parsed.api.image, "deployment-platform-api:0.1.1");
  assert.equal(parsed.api.state, "running");
  assert.equal(parsed.web.state, "exited");
});
