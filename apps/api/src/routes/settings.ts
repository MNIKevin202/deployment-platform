import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { AppDatabase } from "../database.js";
import { commitRestore, createBackupArchive, stageRestore } from "../services/backup-service.js";

/** Generous ceiling — the platform DB is normally well under a megabyte. */
const RESTORE_MAX_BYTES = 128 * 1024 * 1024;

export interface RegisterSettingsRoutesOptions {
  appDatabase: AppDatabase;
  dbPath: string;
  backupsDir: string;
  /**
   * Performs the given atomic swap and then restarts the process. Injectable
   * so tests never actually exit. In production the swap runs immediately
   * before process exit so the container reopens the restored database.
   */
  scheduleRestart?: (commit: () => void) => void;
}

const defaultScheduleRestart = (commit: () => void): void => {
  // Delay briefly so the success response flushes to the client before the
  // process exits and the container (restart policy: unless-stopped) restarts.
  setTimeout(() => {
    try {
      commit();
    } finally {
      process.exit(0);
    }
  }, 250);
};

export async function registerSettingsRoutes(
  fastify: FastifyInstance,
  { appDatabase, dbPath, backupsDir, scheduleRestart = defaultScheduleRestart }: RegisterSettingsRoutesOptions
): Promise<void> {
  // Download a full backup of the platform's configuration database.
  fastify.get(
    "/settings/backup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      const schemaVersion =
        (appDatabase.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
          v: number | null;
        }).v ?? 0;
      const appCount = appDatabase.listApps().length;

      const archive = await createBackupArchive({
        snapshotTo: (dest) => appDatabase.db.exec(`VACUUM INTO '${dest}'`),
        schemaVersion,
        appCount
      });

      reply.header("Content-Type", "application/gzip");
      reply.header("Content-Disposition", `attachment; filename="${archive.filename}"`);

      const stream = createReadStream(archive.archivePath);
      // Clean up the temp working directory once the archive is fully sent.
      stream.on("close", archive.cleanup);
      stream.on("error", archive.cleanup);

      return reply.send(stream);
    }
  );

  // Restore the platform from a previously downloaded backup. Destructive:
  // replaces the current database and restarts the API.
  fastify.post(
    "/settings/restore",
    { bodyLimit: RESTORE_MAX_BYTES, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = request.body;

      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ success: false, message: "No backup file was uploaded." });
      }

      const staged = await stageRestore({ dbPath, archiveBuffer: body, backupsDir });

      if (!staged.ok || !staged.stagingPath) {
        // The live database was never touched.
        return reply.code(400).send({ success: false, message: staged.error ?? "Restore failed." });
      }

      const stagingPath = staged.stagingPath;

      // Acknowledge before restarting so the client sees the result.
      await reply.send({
        success: true,
        message: "Backup restored. The platform is restarting to load it — this takes a few seconds.",
        manifest: staged.manifest ?? null
      });

      scheduleRestart(() => {
        // Close the live connection first so no write lands on the swapped
        // file, then move the restored database into place atomically.
        appDatabase.close();
        commitRestore(stagingPath, dbPath);
      });

      return reply;
    }
  );
}
