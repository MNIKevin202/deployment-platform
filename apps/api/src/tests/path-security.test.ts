import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { PathSecurityError, joinRepoPath, resolveWithinRoot } from "../services/path-security.js";

describe("resolveWithinRoot", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "path-security-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("resolves a safe nested relative path inside the root", () => {
    const resolved = resolveWithinRoot(root, "services/api/Dockerfile");
    assert.equal(resolved, join(root, "services", "api", "Dockerfile"));
  });

  test('resolves "." to the root itself', () => {
    assert.equal(resolveWithinRoot(root, "."), root);
  });

  test("rejects a path containing a null byte", () => {
    assert.throws(() => resolveWithinRoot(root, "Dockerfile\0"), PathSecurityError);
  });

  test("rejects a traversal that would escape the root", () => {
    assert.throws(() => resolveWithinRoot(root, "../../etc/passwd"), PathSecurityError);
  });

  test("rejects an absolute path pointing outside the root", () => {
    assert.throws(() => resolveWithinRoot(root, "/etc/passwd"), PathSecurityError);
  });

  test("rejects a deeply nested traversal that cancels out to outside the root", () => {
    assert.throws(() => resolveWithinRoot(root, "a/b/../../../c"), PathSecurityError);
  });

  test("accepts a nested traversal that stays inside the root overall", () => {
    const resolved = resolveWithinRoot(root, "a/b/../c");
    assert.equal(resolved, join(root, "a", "c"));
  });
});

describe("joinRepoPath", () => {
  test('subdirectory "." + a plain file -> just the file (repo-root case, unchanged behavior)', () => {
    assert.equal(joinRepoPath(".", "Dockerfile"), "Dockerfile");
  });

  test('a real subdirectory + "." -> the subdirectory itself, not the repo root (requirement 4)', () => {
    assert.equal(joinRepoPath("tools/x", "."), "tools/x");
  });

  test("a real subdirectory + a plain file -> subdirectory/file", () => {
    assert.equal(joinRepoPath("tools/x", "Dockerfile"), "tools/x/Dockerfile");
  });

  test("a real subdirectory + a nested relative path -> subdirectory/nested/path (requirement 3)", () => {
    assert.equal(joinRepoPath("tools/x", "docker/Dockerfile"), "tools/x/docker/Dockerfile");
  });

  // Regression fixture matching the real roadmapstudio-web app exactly.
  test("regression fixture: MNIKevin202/DeploymentPlatformInstaller's roadmapstudio-web configuration", () => {
    const subdirectory = "tools/roadmap-studio";
    const dockerfilePath = "Dockerfile";
    const buildContext = ".";

    assert.equal(joinRepoPath(subdirectory, dockerfilePath), "tools/roadmap-studio/Dockerfile");
    assert.equal(joinRepoPath(subdirectory, buildContext), "tools/roadmap-studio");
  });

  test("collapses duplicate slashes safely (requirement 6)", () => {
    assert.equal(joinRepoPath("tools//x", "Dockerfile"), "tools/x/Dockerfile");
    assert.equal(joinRepoPath("tools/x", "docker//Dockerfile"), "tools/x/docker/Dockerfile");
  });

  test('strips a leading "./" safely (requirement 6)', () => {
    assert.equal(joinRepoPath("tools/x", "./Dockerfile"), "tools/x/Dockerfile");
  });

  test('rejects ".." in the relative path rather than silently rewriting it (requirements 5 and 7)', () => {
    assert.throws(() => joinRepoPath("tools/x", "../Dockerfile"), PathSecurityError);
    assert.throws(() => joinRepoPath("tools/x", "docker/../../etc/passwd"), PathSecurityError);
  });

  test('rejects ".." in the subdirectory itself', () => {
    assert.throws(() => joinRepoPath("../etc", "Dockerfile"), PathSecurityError);
  });

  test("rejects an absolute path for either argument (requirement 5)", () => {
    assert.throws(() => joinRepoPath("/etc", "Dockerfile"), PathSecurityError);
    assert.throws(() => joinRepoPath("tools/x", "/etc/passwd"), PathSecurityError);
  });

  test("the effective path stays inside the checkout when resolved via resolveWithinRoot", () => {
    const checkoutRoot = mkdtempSync(join(tmpdir(), "path-security-test-"));
    try {
      const effective = joinRepoPath("tools/roadmap-studio", "Dockerfile");
      const resolved = resolveWithinRoot(checkoutRoot, effective);
      assert.equal(resolved, join(checkoutRoot, "tools", "roadmap-studio", "Dockerfile"));
    } finally {
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  test("does not silently accept a rejected path by falling back to some other valid scope (requirement 7)", () => {
    // A naive "strip .. segments" implementation would turn this into
    // "tools/x/etc/passwd" (a different, still-valid-looking path) instead
    // of failing loudly — assert it throws instead of returning anything.
    assert.throws(() => joinRepoPath("tools/x", "../../etc/passwd"), PathSecurityError);
  });
});
