import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrations/index.js";
import { createEnvironmentRepository } from "./environment-database.js";
import { createVolumeRepository } from "./volume-database.js";

export type {
  StoredGlobalEnvVar,
  StoredAppEnvVar,
  CreateGlobalEnvVarInput,
  UpdateGlobalEnvVarInput,
  CreateAppEnvVarInput,
  UpdateAppEnvVarInput
} from "./environment-database.js";

export type {
  StoredAppVolume,
  CreateAppVolumeInput,
  UpdateAppVolumeInput
} from "./volume-database.js";

export interface StoredApp {
  id: number;
  name: string;
  containerId: string | null;
  containerName: string | null;
  image: string;
  containerPort: number;
  domain: string | null;
  status: string;
  desiredStatus: string;
  restartPolicy: string;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt: string | null;
  environmentTouchedAt: string | null;
}

interface AppRow {
  id: number;
  name: string;
  container_id: string | null;
  container_name: string | null;
  image: string;
  container_port: number;
  domain: string | null;
  status: string;
  desired_status: string;
  restart_policy: string;
  created_at: string;
  updated_at: string;
  last_deployed_at: string | null;
  environment_touched_at: string | null;
}

const APP_COLUMNS = `
  id,
  name,
  container_id,
  container_name,
  image,
  container_port,
  domain,
  status,
  desired_status,
  restart_policy,
  created_at,
  updated_at,
  last_deployed_at,
  environment_touched_at
`;

function mapApp(row: AppRow): StoredApp {
  return {
    id: row.id,
    name: row.name,
    containerId: row.container_id,
    containerName: row.container_name,
    image: row.image,
    containerPort: row.container_port,
    domain: row.domain,
    status: row.status,
    desiredStatus: row.desired_status,
    restartPolicy: row.restart_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastDeployedAt: row.last_deployed_at,
    environmentTouchedAt: row.environment_touched_at
  };
}

export interface CreateAppInput {
  name: string;
  image: string;
  containerPort: number;
  containerName: string;
  domain?: string | null;
  restartPolicy?: string;
}

export interface UpdateAppContainerInput {
  containerId: string;
  status: string;
}

export function createAppDatabase(databasePath: string) {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), {
      recursive: true
    });
  }

  const db = new DatabaseSync(databasePath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);

  runMigrations(db);

  function listApps(): StoredApp[] {
    const rows = db
      .prepare(
        `SELECT ${APP_COLUMNS} FROM apps ORDER BY created_at DESC`
      )
      .all() as unknown as AppRow[];

    return rows.map(mapApp);
  }

  function getAppById(id: number): StoredApp | null {
    const row = db
      .prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`)
      .get(id) as unknown as AppRow | undefined;

    return row ? mapApp(row) : null;
  }

  function getAppByName(name: string): StoredApp | null {
    const row = db
      .prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE name = ?`)
      .get(name) as unknown as AppRow | undefined;

    return row ? mapApp(row) : null;
  }

  function getAppByDomain(domain: string): StoredApp | null {
    const row = db
      .prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE domain = ?`)
      .get(domain) as unknown as AppRow | undefined;

    return row ? mapApp(row) : null;
  }

  function createApp(input: CreateAppInput): StoredApp {
    db.prepare(
      `
        INSERT INTO apps (
          name,
          image,
          container_port,
          container_name,
          domain,
          status,
          desired_status,
          restart_policy
        )
        VALUES (?, ?, ?, ?, ?, 'created', 'running', ?)
      `
    ).run(
      input.name,
      input.image,
      input.containerPort,
      input.containerName,
      input.domain ?? null,
      input.restartPolicy ?? "unless-stopped"
    );

    const app = getAppByName(input.name);

    if (!app) {
      throw new Error("Stored app could not be loaded after creation");
    }

    return app;
  }

  function updateAppContainer(
    id: number,
    input: UpdateAppContainerInput
  ): void {
    db.prepare(
      `
        UPDATE apps
        SET
          container_id = ?,
          status = ?,
          last_deployed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(input.containerId, input.status, id);
  }

  function updateAppStatus(id: number, status: string): void {
    db.prepare(
      `
        UPDATE apps
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(status, id);
  }

  function updateAppDesiredStatus(
    id: number,
    desiredStatus: string
  ): void {
    db.prepare(
      `
        UPDATE apps
        SET desired_status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(desiredStatus, id);
  }

  function updateAppDomain(id: number, domain: string | null): void {
    db.prepare(
      `
        UPDATE apps
        SET domain = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(domain, id);
  }

  function updateAppImage(id: number, image: string): void {
    db.prepare(
      `
        UPDATE apps
        SET image = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(image, id);
  }

  function deleteApp(id: number): void {
    db.prepare(`DELETE FROM apps WHERE id = ?`).run(id);
  }

  /**
   * Despite the column/function name, this now marks "something about this
   * app's deployable configuration changed" broadly — both environment
   * variables (Phase 5) and storage mounts (Phase 7) call this. Docker
   * can't apply either kind of change to a running container, so both are
   * "pending" until the next redeploy. Not renamed to avoid a wider,
   * harder-to-verify rename across already-shipped call sites.
   */
  function touchAppEnvironment(id: number): void {
    db.prepare(
      `UPDATE apps SET environment_touched_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(id);
  }

  function touchAllAppsEnvironment(): void {
    db.exec(
      `UPDATE apps SET environment_touched_at = CURRENT_TIMESTAMP`
    );
  }

  function healthCheck(): boolean {
    const result = db.prepare("SELECT 1 AS healthy").get() as {
      healthy: number;
    };

    return result.healthy === 1;
  }

  function close(): void {
    db.close();
  }

  const environmentRepository = createEnvironmentRepository(db);
  const volumeRepository = createVolumeRepository(db);

  return {
    db,
    listApps,
    getAppById,
    getAppByName,
    getAppByDomain,
    createApp,
    updateAppContainer,
    updateAppStatus,
    updateAppDesiredStatus,
    updateAppDomain,
    updateAppImage,
    deleteApp,
    touchAppEnvironment,
    touchAllAppsEnvironment,
    healthCheck,
    close,
    ...environmentRepository,
    ...volumeRepository
  };
}

export type AppDatabase = ReturnType<typeof createAppDatabase>;
