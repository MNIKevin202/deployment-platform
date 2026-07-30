import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase } from "../database.js";
import {
  commitRestore,
  createBackupArchive,
  stageRestore,
  validateBackupDatabase
} from "../services/backup-service.js";

describe("backup-service round trip", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "dp-backup-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function dbPath(name: string) {
    return join(workDir, `${name}-${randomUUID()}.sqlite`);
  }

  async function backupOf(pathToDb: string): Promise<Buffer> {
    const db = createAppDatabase(pathToDb);
    try {
      const schemaVersion =
        (db.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
      const archive = await createBackupArchive({
        snapshotTo: (dest) => db.db.exec(`VACUUM INTO '${dest}'`),
        schemaVersion,
        appCount: db.listApps().length
      });
      const buffer = readFileSync(archive.archivePath);
      archive.cleanup();
      return buffer;
    } finally {
      db.close();
    }
  }

  test("a backup of one database restores over another, keeping a pre-restore copy", async () => {
    const pathA = dbPath("a");
    const dbA = createAppDatabase(pathA);
    dbA.createApp({ name: "alpha", image: "nginx:alpine", containerPort: 80, containerName: "app-alpha" });
    dbA.close();

    const backup = await backupOf(pathA);

    const pathB = dbPath("b");
    const dbB = createAppDatabase(pathB);
    dbB.createApp({ name: "beta", image: "nginx:alpine", containerPort: 80, containerName: "app-beta" });
    dbB.close();

    const staged = await stageRestore({
      dbPath: pathB,
      archiveBuffer: backup,
      backupsDir: join(workDir, "backups")
    });

    assert.equal(staged.ok, true);
    assert.ok(staged.stagingPath);
    assert.ok(staged.preRestoreBackupPath);
    assert.equal(staged.manifest?.format, "deployment-platform-backup");

    commitRestore(staged.stagingPath!, pathB);

    // B now holds A's content ("alpha"), not its own ("beta").
    const restored = createAppDatabase(pathB);
    assert.deepEqual(
      restored.listApps().map((app) => app.name),
      ["alpha"]
    );
    restored.close();

    // The pre-restore safety copy preserved B's original content ("beta").
    const preRestore = createAppDatabase(staged.preRestoreBackupPath!);
    assert.deepEqual(
      preRestore.listApps().map((app) => app.name),
      ["beta"]
    );
    preRestore.close();
  });

  test("rejects a file that is not a valid archive, leaving the live DB untouched", async () => {
    const pathB = dbPath("b");
    const dbB = createAppDatabase(pathB);
    dbB.createApp({ name: "beta", image: "nginx:alpine", containerPort: 80, containerName: "app-beta" });
    dbB.close();

    const staged = await stageRestore({
      dbPath: pathB,
      archiveBuffer: Buffer.from("this is not a tar.gz"),
      backupsDir: join(workDir, "backups")
    });

    assert.equal(staged.ok, false);
    assert.match(staged.error ?? "", /not a valid backup archive/);

    // Live DB is intact.
    const dbCheck = createAppDatabase(pathB);
    assert.deepEqual(
      dbCheck.listApps().map((app) => app.name),
      ["beta"]
    );
    dbCheck.close();
  });

  test("rejects an archive whose database isn't a platform database", async () => {
    // A valid tar.gz, but database.sqlite is just junk.
    const stageDir = mkdtempSync(join(tmpdir(), "dp-bad-"));
    writeFileSync(join(stageDir, "database.sqlite"), "not a sqlite file");
    const { execFileSync } = await import("node:child_process");
    const archivePath = join(stageDir, "bad.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", stageDir, "database.sqlite"]);

    const pathB = dbPath("b");
    createAppDatabase(pathB).close();

    const staged = await stageRestore({
      dbPath: pathB,
      archiveBuffer: readFileSync(archivePath),
      backupsDir: join(workDir, "backups")
    });

    rmSync(stageDir, { recursive: true, force: true });

    assert.equal(staged.ok, false);
    assert.match(staged.error ?? "", /valid platform database|could not be opened/);
  });

  test("validateBackupDatabase accepts a real platform DB and rejects junk", () => {
    const good = dbPath("good");
    createAppDatabase(good).close();
    assert.equal(validateBackupDatabase(good).ok, true);

    const junk = join(workDir, "junk.sqlite");
    writeFileSync(junk, "nope");
    assert.equal(validateBackupDatabase(junk).ok, false);
  });
});
