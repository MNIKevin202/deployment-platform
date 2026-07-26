import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  cloneRepositoryBranch,
  CloneError,
  describeCloneFailure,
  describeSpawnFailure,
  verifyGitAvailable
} from "../services/github-clone-service.js";

const FAKE_TOKEN = "fake_token_for_tests_only";

// A guaranteed-nonexistent absolute path — deterministically forces
// ENOENT on every platform, unlike clearing PATH (which does not
// reliably work: macOS in particular falls back to a default system
// PATH containing a real `git` when the child's own PATH is empty).
const NONEXISTENT_GIT = "/definitely-not-present/deployment-platform-test-git";

/**
 * Builds a directory containing a fake `git` executable and returns its
 * absolute path, for use as the `gitExecutable` override — never a real
 * git binary, never a real network call, never a real repository or
 * token.
 */
function makeFakeGit(scriptBody: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fake-git-"));
  const gitPath = join(dir, "git");
  writeFileSync(gitPath, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o700 });
  chmodSync(gitPath, 0o700);
  return { path: gitPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("describeSpawnFailure", () => {
  test("maps ENOENT to a clear, specific message", () => {
    assert.equal(describeSpawnFailure("ENOENT"), "Git executable was not found");
  });

  test("still gives a specific-ish message for other spawn error codes", () => {
    assert.match(describeSpawnFailure("EACCES"), /EACCES/);
  });
});

describe("describeCloneFailure", () => {
  test("maps a missing branch", () => {
    const message = describeCloneFailure("release", 128, "fatal: could not find remote branch release to clone.");
    assert.equal(message, 'Branch "release" was not found');
  });

  test("maps repository-not-found", () => {
    const message = describeCloneFailure("main", 128, "remote: Repository not found.\nfatal: repository not found");
    assert.equal(message, "Repository was not found or access was denied");
  });

  test("maps authentication failure", () => {
    const message = describeCloneFailure("main", 128, "fatal: Authentication failed while cloning");
    assert.equal(message, "GitHub authentication failed");
  });

  test("maps a network/TLS failure", () => {
    const message = describeCloneFailure("main", 128, "fatal: unable to access: Could not resolve host: github.com");
    assert.equal(message, "TLS/network failure while contacting GitHub");
  });

  test("falls back to a specific exit-code message rather than a vague default", () => {
    const message = describeCloneFailure("main", 128, "some unrecognized git error text");
    assert.equal(message, "Git clone exited with code 128");
    assert.notEqual(message, "git clone failed (exit code unknown)");
  });
});

describe("cloneRepositoryBranch", () => {
  test("reports a clear error when git is not installed (ENOENT), not a vague fallback", async () => {
    await assert.rejects(
      () =>
        cloneRepositoryBranch({
          repositoryOwner: "example",
          repositoryName: "repo",
          branch: "main",
          token: FAKE_TOKEN,
          timeoutMs: 5000,
          maxOutputBytes: 4096,
          gitExecutable: NONEXISTENT_GIT
        }),
      (error: unknown) => {
        if (!(error instanceof CloneError)) {
          return false;
        }
        assert.equal(error.message, "Git executable was not found");
        assert.equal(error.diagnostics.processStarted, false);
        assert.equal(error.diagnostics.spawnErrorCode, "ENOENT");
        return true;
      }
    );
  });

  test("maps a nonzero git exit code to a specific message and structured diagnostics", async () => {
    const fakeGit = makeFakeGit('echo "fatal: Authentication failed while cloning" 1>&2\nexit 128');

    try {
      await assert.rejects(
        () =>
          cloneRepositoryBranch({
            repositoryOwner: "example",
            repositoryName: "repo",
            branch: "main",
            token: FAKE_TOKEN,
            timeoutMs: 5000,
            maxOutputBytes: 4096,
            gitExecutable: fakeGit.path
          }),
        (error: unknown) => {
          if (!(error instanceof CloneError)) {
            return false;
          }
          assert.equal(error.message, "GitHub authentication failed");
          assert.equal(error.diagnostics.exitCode, 128);
          assert.equal(error.diagnostics.processStarted, true);
          assert.equal(error.diagnostics.spawnErrorCode, undefined);
          // Never a raw token, even though the fake credential helper
          // would have written one to a temp file for this call.
          assert.ok(!JSON.stringify(error.diagnostics).includes(FAKE_TOKEN));
          return true;
        }
      );
    } finally {
      fakeGit.cleanup();
    }
  });

  test("falls back to the generic exit-code message when stderr matches no known pattern", async () => {
    const fakeGit = makeFakeGit('echo "some unrecognized git error text" 1>&2\nexit 128');

    try {
      await assert.rejects(
        () =>
          cloneRepositoryBranch({
            repositoryOwner: "example",
            repositoryName: "repo",
            branch: "main",
            token: FAKE_TOKEN,
            timeoutMs: 5000,
            maxOutputBytes: 4096,
            gitExecutable: fakeGit.path
          }),
        (error: unknown) => {
          if (!(error instanceof CloneError)) {
            return false;
          }
          assert.equal(error.message, "Git clone exited with code 128");
          assert.equal(error.diagnostics.exitCode, 128);
          assert.equal(error.diagnostics.processStarted, true);
          assert.equal(error.diagnostics.spawnErrorCode, undefined);
          return true;
        }
      );
    } finally {
      fakeGit.cleanup();
    }
  });

  test("reports a timeout distinctly from a nonzero exit code", async () => {
    const fakeGit = makeFakeGit("sleep 5");

    try {
      await assert.rejects(
        () =>
          cloneRepositoryBranch({
            repositoryOwner: "example",
            repositoryName: "repo",
            branch: "main",
            token: FAKE_TOKEN,
            timeoutMs: 200,
            maxOutputBytes: 4096,
            gitExecutable: fakeGit.path
          }),
        (error: unknown) => {
          if (!(error instanceof CloneError)) {
            return false;
          }
          assert.equal(error.message, "Cloning the repository timed out");
          assert.equal(error.diagnostics.timedOut, true);
          return true;
        }
      );
    } finally {
      fakeGit.cleanup();
    }
  });

  test("rejects a branch name that looks like a flag before any process is spawned", async () => {
    await assert.rejects(
      () =>
        cloneRepositoryBranch({
          repositoryOwner: "example",
          repositoryName: "repo",
          branch: "--upload-pack=evil",
          token: FAKE_TOKEN,
          timeoutMs: 5000,
          maxOutputBytes: 4096
        }),
      (error: unknown) => {
        if (!(error instanceof CloneError)) {
          return false;
        }
        assert.equal(error.diagnostics.processStarted, false);
        return true;
      }
    );
  });
});

describe("verifyGitAvailable", () => {
  test("reports unavailable with a clear ENOENT reason when git cannot be found", async () => {
    const result = await verifyGitAvailable(NONEXISTENT_GIT);
    assert.equal(result.available, false);
    assert.equal(result.reason, "Git executable was not found");
  });

  test("reports available with a version string when a fake git responds successfully", async () => {
    const fakeGit = makeFakeGit('echo "git version 2.99.0 (fake)"');
    try {
      const result = await verifyGitAvailable(fakeGit.path);
      assert.equal(result.available, true);
      assert.ok(result.version?.includes("2.99.0"));
    } finally {
      fakeGit.cleanup();
    }
  });
});
