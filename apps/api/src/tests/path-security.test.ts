import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { PathSecurityError, resolveWithinRoot } from "../services/path-security.js";

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
