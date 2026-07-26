import type { DatabaseSync } from "node:sqlite";

export interface StoredAppVolume {
  id: number;
  appId: number;
  volumeName: string;
  containerPath: string;
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AppVolumeRow {
  id: number;
  app_id: number;
  volume_name: string;
  container_path: string;
  read_only: number;
  created_at: string;
  updated_at: string;
}

function mapAppVolume(row: AppVolumeRow): StoredAppVolume {
  return {
    id: row.id,
    appId: row.app_id,
    volumeName: row.volume_name,
    containerPath: row.container_path,
    readOnly: row.read_only === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface CreateAppVolumeInput {
  appId: number;
  volumeName: string;
  containerPath: string;
  readOnly: boolean;
}

export interface UpdateAppVolumeInput {
  containerPath?: string;
  readOnly?: boolean;
}

const APP_VOLUME_COLUMNS = `
  id, app_id, volume_name, container_path, read_only, created_at, updated_at
`;

export function createVolumeRepository(db: DatabaseSync) {
  function listAppVolumes(appId: number): StoredAppVolume[] {
    const rows = db
      .prepare(
        `SELECT ${APP_VOLUME_COLUMNS} FROM app_volumes WHERE app_id = ? ORDER BY container_path ASC`
      )
      .all(appId) as unknown as AppVolumeRow[];

    return rows.map(mapAppVolume);
  }

  function getAppVolumeById(id: number): StoredAppVolume | null {
    const row = db
      .prepare(`SELECT ${APP_VOLUME_COLUMNS} FROM app_volumes WHERE id = ?`)
      .get(id) as unknown as AppVolumeRow | undefined;

    return row ? mapAppVolume(row) : null;
  }

  function getAppVolumeByPath(
    appId: number,
    containerPath: string
  ): StoredAppVolume | null {
    const row = db
      .prepare(
        `SELECT ${APP_VOLUME_COLUMNS} FROM app_volumes WHERE app_id = ? AND container_path = ?`
      )
      .get(appId, containerPath) as unknown as AppVolumeRow | undefined;

    return row ? mapAppVolume(row) : null;
  }

  function getAppVolumeByName(volumeName: string): StoredAppVolume | null {
    const row = db
      .prepare(
        `SELECT ${APP_VOLUME_COLUMNS} FROM app_volumes WHERE volume_name = ?`
      )
      .get(volumeName) as unknown as AppVolumeRow | undefined;

    return row ? mapAppVolume(row) : null;
  }

  function createAppVolume(input: CreateAppVolumeInput): StoredAppVolume {
    db.prepare(
      `
        INSERT INTO app_volumes (app_id, volume_name, container_path, read_only)
        VALUES (?, ?, ?, ?)
      `
    ).run(
      input.appId,
      input.volumeName,
      input.containerPath,
      input.readOnly ? 1 : 0
    );

    const created = getAppVolumeByName(input.volumeName);

    if (!created) {
      throw new Error("App volume could not be loaded after creation");
    }

    return created;
  }

  function updateAppVolume(id: number, input: UpdateAppVolumeInput): void {
    const existing = getAppVolumeById(id);

    if (!existing) {
      throw new Error("App volume not found");
    }

    db.prepare(
      `
        UPDATE app_volumes
        SET container_path = ?, read_only = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(
      input.containerPath ?? existing.containerPath,
      (input.readOnly ?? existing.readOnly) ? 1 : 0,
      id
    );
  }

  function deleteAppVolume(id: number): void {
    db.prepare(`DELETE FROM app_volumes WHERE id = ?`).run(id);
  }

  return {
    listAppVolumes,
    getAppVolumeById,
    getAppVolumeByPath,
    getAppVolumeByName,
    createAppVolume,
    updateAppVolume,
    deleteAppVolume
  };
}

export type VolumeRepository = ReturnType<typeof createVolumeRepository>;
