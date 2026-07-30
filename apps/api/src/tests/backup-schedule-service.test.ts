import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { listAutoBackups, runScheduledBackup } from "../services/backup-schedule-service.js";

describe("backup-schedule-service", () => {
  let dir: string;
  let backupsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dp-autobackup-test-"));
    backupsDir = join(dir, "backups");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeArchive() {
    const archivePath = join(dir, "src.tar.gz");
    writeFileSync(archivePath, "archive-bytes");
    return async () => ({ archivePath, cleanup: () => {} });
  }

  test("writes a timestamped backup and lists it", async () => {
    await runScheduledBackup({
      createArchive: fakeArchive(),
      backupsDir,
      retention: 5,
      now: () => new Date("2026-07-30T10:00:00.000Z")
    });

    const files = listAutoBackups(backupsDir);
    assert.equal(files.length, 1);
    assert.match(files[0].name, /^auto-backup-.*\.tar\.gz$/);
  });

  test("enforces retention, keeping the newest N", async () => {
    // Create 4 backups at increasing times; retention 2 → keep the newest 2.
    for (let i = 1; i <= 4; i += 1) {
      await runScheduledBackup({
        createArchive: fakeArchive(),
        backupsDir,
        retention: 2,
        now: () => new Date(`2026-07-30T10:0${i}:00.000Z`)
      });
    }

    const files = listAutoBackups(backupsDir);
    assert.equal(files.length, 2);
    // Newest first — the two most recent timestamps survive.
    assert.match(files[0].name, /10-04/);
    assert.match(files[1].name, /10-03/);
  });
});
