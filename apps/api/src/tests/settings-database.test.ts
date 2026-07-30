import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("platform settings store", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dp-settings-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns null for an unset key and round-trips a value", () => {
    assert.equal(appDatabase.getSetting("nope"), null);
    appDatabase.setSetting("greeting", "hello");
    assert.equal(appDatabase.getSetting("greeting"), "hello");
  });

  test("upserts an existing key", () => {
    appDatabase.setSetting("k", "one");
    appDatabase.setSetting("k", "two");
    assert.equal(appDatabase.getSetting("k"), "two");
  });

  test("deletes a key", () => {
    appDatabase.setSetting("k", "v");
    appDatabase.deleteSetting("k");
    assert.equal(appDatabase.getSetting("k"), null);
  });

  test("json helpers round-trip structured values", () => {
    appDatabase.setJsonSetting("cfg", { enabled: true, keep: 3 });
    assert.deepEqual(appDatabase.getJsonSetting("cfg"), { enabled: true, keep: 3 });
    assert.equal(appDatabase.getJsonSetting("missing"), null);
  });
});
