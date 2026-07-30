import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import { listAutoBackups } from "../services/backup-schedule-service.js";
import {
  sendNotification,
  type NotificationConfig
} from "../services/notification-service.js";

export const AUTO_BACKUP_KEY = "auto_backup";
export const AUTO_BACKUP_LAST_RUN_KEY = "auto_backup_last_run";
export const NOTIFICATIONS_KEY = "notifications";

export interface AutoBackupConfig {
  enabled: boolean;
  intervalHours: number;
  retention: number;
}

const DEFAULT_AUTO_BACKUP: AutoBackupConfig = { enabled: false, intervalHours: 24, retention: 7 };
const DEFAULT_NOTIFICATIONS: NotificationConfig = { enabled: false, type: "discord", webhookUrl: "" };

const autoBackupSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.coerce.number().int().min(1).max(168),
  retention: z.coerce.number().int().min(1).max(100)
});

const notificationsSchema = z.object({
  enabled: z.boolean(),
  type: z.enum(["discord", "slack", "generic"]),
  webhookUrl: z.string().max(2000)
});

export function readAutoBackupConfig(appDatabase: AppDatabase): AutoBackupConfig {
  return appDatabase.getJsonSetting<AutoBackupConfig>(AUTO_BACKUP_KEY) ?? DEFAULT_AUTO_BACKUP;
}

export function readNotificationConfig(appDatabase: AppDatabase): NotificationConfig {
  return appDatabase.getJsonSetting<NotificationConfig>(NOTIFICATIONS_KEY) ?? DEFAULT_NOTIFICATIONS;
}

interface RegisterPlatformSettingsRoutesOptions {
  appDatabase: AppDatabase;
  backupsDir: string;
  /** Runs a scheduled backup immediately (write to disk + retention). */
  runBackupNow: () => Promise<void>;
}

export async function registerPlatformSettingsRoutes(
  fastify: FastifyInstance,
  { appDatabase, backupsDir, runBackupNow }: RegisterPlatformSettingsRoutesOptions
): Promise<void> {
  // ---- Automatic backups ----
  fastify.get("/settings/auto-backup", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async () => {
    const lastRunRaw = appDatabase.getSetting(AUTO_BACKUP_LAST_RUN_KEY);
    return {
      success: true,
      config: readAutoBackupConfig(appDatabase),
      lastRunAt: lastRunRaw ? Number(lastRunRaw) : null,
      backups: listAutoBackups(backupsDir)
    };
  });

  fastify.patch("/settings/auto-backup", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = autoBackupSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, message: "Invalid auto-backup settings.", errors: parsed.error.flatten() });
    }
    appDatabase.setJsonSetting(AUTO_BACKUP_KEY, parsed.data);
    return { success: true, config: parsed.data };
  });

  fastify.post("/settings/auto-backup/run", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (_request, reply) => {
    try {
      await runBackupNow();
      appDatabase.setSetting(AUTO_BACKUP_LAST_RUN_KEY, String(Date.now()));
      return { success: true, backups: listAutoBackups(backupsDir) };
    } catch (error) {
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : "Backup failed."
      });
    }
  });

  // ---- Deploy notifications ----
  fastify.get("/settings/notifications", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async () => {
    return { success: true, config: readNotificationConfig(appDatabase) };
  });

  fastify.patch("/settings/notifications", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = notificationsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, message: "Invalid notification settings.", errors: parsed.error.flatten() });
    }
    appDatabase.setJsonSetting(NOTIFICATIONS_KEY, parsed.data);
    return { success: true, config: parsed.data };
  });

  fastify.post("/settings/notifications/test", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (_request, reply) => {
    const config = readNotificationConfig(appDatabase);
    const result = await sendNotification(config, "✅ Test notification from your Deployment Platform.");
    if (!result.ok) {
      return reply.code(400).send({ success: false, message: result.error ?? "Test failed." });
    }
    return { success: true, message: "Test notification sent." };
  });
}
