import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const AUTO_PREFIX = "auto-backup-";

export interface AutoBackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

/** Lists the scheduled-backup files in a directory, newest first. */
export function listAutoBackups(backupsDir: string): AutoBackupFile[] {
  let names: string[];
  try {
    names = readdirSync(backupsDir);
  } catch {
    return [];
  }

  return names
    .filter((name) => name.startsWith(AUTO_PREFIX) && name.endsWith(".tar.gz"))
    .map((name) => {
      const stat = statSync(join(backupsDir, name));
      return { name, sizeBytes: stat.size, createdAt: new Date(stat.mtimeMs).toISOString() };
    })
    // Names are ISO-timestamped, so a reverse string sort is newest-first.
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** Keeps the newest `keep` scheduled backups and deletes the rest. */
export function enforceRetention(backupsDir: string, keep: number): void {
  const files = listAutoBackups(backupsDir);
  for (const file of files.slice(Math.max(0, keep))) {
    rmSync(join(backupsDir, file.name), { force: true });
  }
}

export interface RunScheduledBackupOptions {
  /** Produces a temp .tar.gz archive (backup-service.createBackupArchive). */
  createArchive: () => Promise<{ archivePath: string; cleanup: () => void }>;
  backupsDir: string;
  retention: number;
  now?: () => Date;
}

/**
 * Writes a timestamped scheduled backup into `backupsDir` and enforces
 * retention. Returns the written path.
 */
export async function runScheduledBackup(options: RunScheduledBackupOptions): Promise<string> {
  const now = options.now ?? (() => new Date());
  mkdirSync(options.backupsDir, { recursive: true });

  const archive = await options.createArchive();
  try {
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const dest = join(options.backupsDir, `${AUTO_PREFIX}${stamp}.tar.gz`);
    copyFileSync(archive.archivePath, dest);
    enforceRetention(options.backupsDir, options.retention);
    return dest;
  } finally {
    archive.cleanup();
  }
}
