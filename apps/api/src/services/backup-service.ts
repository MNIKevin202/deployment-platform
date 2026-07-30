import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);

/** Entry names inside the backup archive. */
export const BACKUP_DB_ENTRY = "database.sqlite";
export const BACKUP_MANIFEST_ENTRY = "manifest.json";

export interface BackupManifest {
  format: "deployment-platform-backup";
  version: 1;
  createdAt: string;
  /** Highest applied schema-migration version at backup time. */
  schemaVersion: number;
  appCount: number;
}

export interface CreateBackupOptions {
  /** Runs SQLite `VACUUM INTO destPath` on the live DB for a consistent single-file snapshot. */
  snapshotTo: (destPath: string) => void;
  schemaVersion: number;
  appCount: number;
  now?: () => Date;
}

export interface BackupArchive {
  archivePath: string;
  filename: string;
  /** Removes the temp working directory (call after the archive is streamed). */
  cleanup: () => void;
}

/**
 * Produces a gzipped tar containing a consistent snapshot of the platform
 * database plus a small manifest. The snapshot is taken with VACUUM INTO so
 * it is internally consistent even while the live database is in use.
 */
export async function createBackupArchive(options: CreateBackupOptions): Promise<BackupArchive> {
  const now = options.now ?? (() => new Date());
  const workDir = mkdtempSync(join(tmpdir(), "dp-backup-"));

  try {
    options.snapshotTo(join(workDir, BACKUP_DB_ENTRY));

    const manifest: BackupManifest = {
      format: "deployment-platform-backup",
      version: 1,
      createdAt: now().toISOString(),
      schemaVersion: options.schemaVersion,
      appCount: options.appCount
    };
    writeFileSync(join(workDir, BACKUP_MANIFEST_ENTRY), JSON.stringify(manifest, null, 2));

    const archivePath = join(workDir, "backup.tar.gz");
    await execFileAsync("tar", [
      "-czf",
      archivePath,
      "-C",
      workDir,
      BACKUP_DB_ENTRY,
      BACKUP_MANIFEST_ENTRY
    ]);

    const stamp = manifest.createdAt.replace(/[:.]/g, "-");

    return {
      archivePath,
      filename: `deployment-platform-backup-${stamp}.tar.gz`,
      cleanup: () => rmSync(workDir, { recursive: true, force: true })
    };
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

/** Confirms a file is a real platform database (not an arbitrary sqlite/file). */
export function validateBackupDatabase(sqlitePath: string): { ok: boolean; error?: string } {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(sqlitePath);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    if (!tables.includes("schema_migrations") || !tables.includes("apps")) {
      return { ok: false, error: "The archive does not contain a valid platform database." };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "The archive's database could not be opened." };
  } finally {
    db?.close();
  }
}

export interface StageRestoreOptions {
  dbPath: string;
  archiveBuffer: Buffer;
  /** Where the current database is safety-copied before it is replaced. */
  backupsDir: string;
  now?: () => Date;
}

export interface StageRestoreResult {
  ok: boolean;
  error?: string;
  /** Restored DB copied here on the live DB's filesystem, ready for an atomic rename. */
  stagingPath?: string;
  /** Safety copy of the pre-restore database. */
  preRestoreBackupPath?: string;
  manifest?: BackupManifest;
}

/**
 * Validates an uploaded backup archive and stages the restored database next
 * to the live one — WITHOUT touching the live database. Nothing here is
 * destructive: on any validation failure the live database is untouched. The
 * caller performs the atomic swap via `commitRestore` immediately before
 * exiting so the process restarts onto the restored database.
 */
export async function stageRestore(options: StageRestoreOptions): Promise<StageRestoreResult> {
  const now = options.now ?? (() => new Date());
  const workDir = mkdtempSync(join(tmpdir(), "dp-restore-"));

  try {
    const archivePath = join(workDir, "upload.tar.gz");
    writeFileSync(archivePath, options.archiveBuffer);

    try {
      await execFileAsync("tar", ["-xzf", archivePath, "-C", workDir]);
    } catch {
      return { ok: false, error: "The uploaded file is not a valid backup archive." };
    }

    const restoredDb = join(workDir, BACKUP_DB_ENTRY);
    if (!existsSync(restoredDb)) {
      return { ok: false, error: "The backup archive is missing its database." };
    }

    const validation = validateBackupDatabase(restoredDb);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    let manifest: BackupManifest | undefined;
    const manifestPath = join(workDir, BACKUP_MANIFEST_ENTRY);
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
      } catch {
        manifest = undefined;
      }
    }

    const stamp = now().toISOString().replace(/[:.]/g, "-");

    // Safety copy of the current database before anything replaces it.
    let preRestoreBackupPath: string | undefined;
    if (existsSync(options.dbPath)) {
      mkdirSync(options.backupsDir, { recursive: true });
      preRestoreBackupPath = join(options.backupsDir, `pre-restore-${stamp}.sqlite`);
      copyFileSync(options.dbPath, preRestoreBackupPath);
    }

    // Copy the restored DB onto the live DB's own filesystem so the final
    // swap can be an atomic same-directory rename.
    const stagingPath = `${options.dbPath}.restore-${stamp}`;
    copyFileSync(restoredDb, stagingPath);

    return { ok: true, stagingPath, preRestoreBackupPath, manifest };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Atomically moves a staged database into place and clears any stale WAL/SHM
 * sidecars. Call this only after the live database connection has been closed,
 * and exit the process immediately afterwards so it reopens the restored file.
 */
export function commitRestore(stagingPath: string, dbPath: string): void {
  renameSync(stagingPath, dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      rmSync(sidecar, { force: true });
    }
  }
}
