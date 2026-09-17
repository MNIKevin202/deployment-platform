import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  compareSemVer,
  isNewerSemVer,
  isOlderSemVer,
  isPatchOnlyUpgrade,
  isValidSemVer,
  parseSemVer
} from "../services/semver.js";

describe("semver", () => {
  test("isValidSemVer accepts only strict MAJOR.MINOR.PATCH", () => {
    assert.equal(isValidSemVer("1.2.3"), true);
    assert.equal(isValidSemVer("0.0.0"), true);
    assert.equal(isValidSemVer("1.2"), false);
    assert.equal(isValidSemVer("1.2.3.4"), false);
    assert.equal(isValidSemVer("1.2.3-beta"), false);
    assert.equal(isValidSemVer("v1.2.3"), false);
    assert.equal(isValidSemVer("latest"), false);
    assert.equal(isValidSemVer(""), false);
  });

  test("parseSemVer throws on an invalid string", () => {
    assert.throws(() => parseSemVer("not-a-version"));
    assert.throws(() => parseSemVer("1.2.3-rc1"));
  });

  test("compareSemVer orders by major, then minor, then patch", () => {
    assert.equal(compareSemVer("1.0.0", "1.0.0"), 0);
    assert.equal(compareSemVer("2.0.0", "1.9.9"), 1);
    assert.equal(compareSemVer("1.9.9", "2.0.0"), -1);
    assert.equal(compareSemVer("1.2.0", "1.1.9"), 1);
    assert.equal(compareSemVer("1.1.9", "1.2.0"), -1);
    assert.equal(compareSemVer("1.2.4", "1.2.3"), 1);
    assert.equal(compareSemVer("1.2.3", "1.2.4"), -1);
  });

  // A naive string comparison would get this one wrong ("10.0.0" < "9.0.0"
  // lexicographically) — this is the case that actually justifies parsing
  // into numeric components instead of comparing version strings directly.
  test("compareSemVer compares numerically, not lexicographically", () => {
    assert.equal(compareSemVer("10.0.0", "9.0.0"), 1);
    assert.equal(compareSemVer("1.10.0", "1.9.0"), 1);
  });

  test("isNewerSemVer / isOlderSemVer", () => {
    assert.equal(isNewerSemVer("1.2.4", "1.2.3"), true);
    assert.equal(isNewerSemVer("1.2.3", "1.2.3"), false);
    assert.equal(isOlderSemVer("1.2.2", "1.2.3"), true);
    assert.equal(isOlderSemVer("1.2.3", "1.2.3"), false);
  });

  test("isPatchOnlyUpgrade is true only for a same-major.minor, higher-patch candidate", () => {
    assert.equal(isPatchOnlyUpgrade("1.2.3", "1.2.4"), true);
    assert.equal(isPatchOnlyUpgrade("1.2.3", "1.2.3"), false, "not an upgrade at all");
    assert.equal(isPatchOnlyUpgrade("1.2.3", "1.3.0"), false, "minor bump, not patch-only");
    assert.equal(isPatchOnlyUpgrade("1.2.3", "2.0.0"), false, "major bump, not patch-only");
    assert.equal(isPatchOnlyUpgrade("1.2.3", "1.2.2"), false, "a downgrade is never a patch upgrade");
  });
});
