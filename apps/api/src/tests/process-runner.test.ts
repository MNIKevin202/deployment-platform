import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildMinimalEnv, runProcess, sanitizeProcessOutput } from "../services/process-runner.js";

const node = process.execPath;

describe("runProcess", () => {
  test("captures stdout and a zero exit code for a successful process", async () => {
    const result = await runProcess({
      command: node,
      args: ["-e", "process.stdout.write('hello')"],
      env: buildMinimalEnv(),
      timeoutMs: 5000,
      maxOutputBytes: 4096
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "hello");
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
  });

  test("captures a nonzero exit code without throwing", async () => {
    const result = await runProcess({
      command: node,
      args: ["-e", "process.exit(3)"],
      env: buildMinimalEnv(),
      timeoutMs: 5000,
      maxOutputBytes: 4096
    });

    assert.equal(result.exitCode, 3);
  });

  test("enforces the timeout and kills the process", async () => {
    const result = await runProcess({
      command: node,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      env: buildMinimalEnv(),
      timeoutMs: 200,
      maxOutputBytes: 4096
    });

    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  });

  test("bounds captured output instead of buffering without limit", async () => {
    const result = await runProcess({
      command: node,
      args: ["-e", "process.stdout.write('x'.repeat(1_000_000))"],
      env: buildMinimalEnv(),
      timeoutMs: 5000,
      maxOutputBytes: 1024
    });

    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= 1024);
  });

  test("honors an AbortSignal", async () => {
    const controller = new AbortController();
    const promise = runProcess({
      command: node,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      env: buildMinimalEnv(),
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      signal: controller.signal
    });

    controller.abort();
    const result = await promise;
    assert.equal(result.aborted, true);
  });

  test("reports a process-spawn error without throwing", async () => {
    const result = await runProcess({
      command: "this-binary-almost-certainly-does-not-exist-anywhere",
      args: [],
      env: buildMinimalEnv(),
      timeoutMs: 5000,
      maxOutputBytes: 4096
    });

    assert.equal(result.exitCode, null);
  });

  test("rejects synchronously when the working directory does not exist", async () => {
    await assert.rejects(() =>
      runProcess({
        command: node,
        args: ["-e", "process.exit(0)"],
        cwd: "/this/path/almost-certainly/does-not-exist",
        env: buildMinimalEnv(),
        timeoutMs: 5000,
        maxOutputBytes: 4096
      })
    );
  });
});

describe("sanitizeProcessOutput", () => {
  test("drops lines that look like they carry a credential", () => {
    const input = [
      "Cloning into 'repo'...",
      "Authorization: Bearer secret-value-here",
      "remote: Counting objects: 10, done."
    ].join("\n");

    const sanitized = sanitizeProcessOutput(input);
    assert.ok(!sanitized.includes("secret-value-here"));
    assert.ok(sanitized.includes("Cloning into"));
    assert.ok(sanitized.includes("Counting objects"));
  });

  test("leaves ordinary output untouched", () => {
    const input = "Cloning into 'repo'...\ndone.";
    assert.equal(sanitizeProcessOutput(input), input);
  });
});

describe("buildMinimalEnv", () => {
  test("never inherits the parent process's full environment implicitly", () => {
    const env = buildMinimalEnv({ FOO: "bar" });
    assert.equal(env.FOO, "bar");
    // Only PATH (if set) plus explicit overrides — nothing else should
    // silently ride along.
    const allowedKeys = new Set(["PATH", "FOO"]);
    for (const key of Object.keys(env)) {
      assert.ok(allowedKeys.has(key), `unexpected key leaked into the child environment: ${key}`);
    }
  });
});
