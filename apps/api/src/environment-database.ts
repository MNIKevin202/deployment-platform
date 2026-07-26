import type { DatabaseSync } from "node:sqlite";

export interface StoredGlobalEnvVar {
  id: number;
  key: string;
  value: string;
  isSecret: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAppEnvVar {
  id: number;
  appId: number;
  key: string;
  value: string;
  isSecret: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GlobalEnvVarRow {
  id: number;
  key: string;
  value: string;
  is_secret: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface AppEnvVarRow {
  id: number;
  app_id: number;
  key: string;
  value: string;
  is_secret: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function mapGlobalEnvVar(row: GlobalEnvVarRow): StoredGlobalEnvVar {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    isSecret: row.is_secret === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAppEnvVar(row: AppEnvVarRow): StoredAppEnvVar {
  return {
    id: row.id,
    appId: row.app_id,
    key: row.key,
    value: row.value,
    isSecret: row.is_secret === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface CreateGlobalEnvVarInput {
  key: string;
  value: string;
  isSecret: boolean;
  enabled: boolean;
}

export interface UpdateGlobalEnvVarInput {
  value?: string;
  isSecret?: boolean;
  enabled?: boolean;
}

export interface CreateAppEnvVarInput {
  appId: number;
  key: string;
  value: string;
  isSecret: boolean;
  enabled: boolean;
}

export interface UpdateAppEnvVarInput {
  value?: string;
  isSecret?: boolean;
  enabled?: boolean;
}

const GLOBAL_ENV_COLUMNS = `
  id, key, value, is_secret, enabled, created_at, updated_at
`;

const APP_ENV_COLUMNS = `
  id, app_id, key, value, is_secret, enabled, created_at, updated_at
`;

export function createEnvironmentRepository(db: DatabaseSync) {
  function listGlobalEnvVars(): StoredGlobalEnvVar[] {
    const rows = db
      .prepare(
        `SELECT ${GLOBAL_ENV_COLUMNS} FROM global_environment_variables ORDER BY key ASC`
      )
      .all() as unknown as GlobalEnvVarRow[];

    return rows.map(mapGlobalEnvVar);
  }

  function getGlobalEnvVarById(id: number): StoredGlobalEnvVar | null {
    const row = db
      .prepare(
        `SELECT ${GLOBAL_ENV_COLUMNS} FROM global_environment_variables WHERE id = ?`
      )
      .get(id) as unknown as GlobalEnvVarRow | undefined;

    return row ? mapGlobalEnvVar(row) : null;
  }

  function getGlobalEnvVarByKey(key: string): StoredGlobalEnvVar | null {
    const row = db
      .prepare(
        `SELECT ${GLOBAL_ENV_COLUMNS} FROM global_environment_variables WHERE key = ?`
      )
      .get(key) as unknown as GlobalEnvVarRow | undefined;

    return row ? mapGlobalEnvVar(row) : null;
  }

  function createGlobalEnvVar(
    input: CreateGlobalEnvVarInput
  ): StoredGlobalEnvVar {
    db.prepare(
      `
        INSERT INTO global_environment_variables (key, value, is_secret, enabled)
        VALUES (?, ?, ?, ?)
      `
    ).run(
      input.key,
      input.value,
      input.isSecret ? 1 : 0,
      input.enabled ? 1 : 0
    );

    const created = getGlobalEnvVarByKey(input.key);

    if (!created) {
      throw new Error(
        "Global environment variable could not be loaded after creation"
      );
    }

    return created;
  }

  function updateGlobalEnvVar(
    id: number,
    input: UpdateGlobalEnvVarInput
  ): void {
    const existing = getGlobalEnvVarById(id);

    if (!existing) {
      throw new Error("Global environment variable not found");
    }

    db.prepare(
      `
        UPDATE global_environment_variables
        SET value = ?, is_secret = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(
      input.value ?? existing.value,
      (input.isSecret ?? existing.isSecret) ? 1 : 0,
      (input.enabled ?? existing.enabled) ? 1 : 0,
      id
    );
  }

  function deleteGlobalEnvVar(id: number): void {
    db.prepare(
      `DELETE FROM global_environment_variables WHERE id = ?`
    ).run(id);
  }

  function listAppEnvVars(appId: number): StoredAppEnvVar[] {
    const rows = db
      .prepare(
        `SELECT ${APP_ENV_COLUMNS} FROM app_environment_variables WHERE app_id = ? ORDER BY key ASC`
      )
      .all(appId) as unknown as AppEnvVarRow[];

    return rows.map(mapAppEnvVar);
  }

  function getAppEnvVarById(id: number): StoredAppEnvVar | null {
    const row = db
      .prepare(
        `SELECT ${APP_ENV_COLUMNS} FROM app_environment_variables WHERE id = ?`
      )
      .get(id) as unknown as AppEnvVarRow | undefined;

    return row ? mapAppEnvVar(row) : null;
  }

  function getAppEnvVarByKey(
    appId: number,
    key: string
  ): StoredAppEnvVar | null {
    const row = db
      .prepare(
        `SELECT ${APP_ENV_COLUMNS} FROM app_environment_variables WHERE app_id = ? AND key = ?`
      )
      .get(appId, key) as unknown as AppEnvVarRow | undefined;

    return row ? mapAppEnvVar(row) : null;
  }

  function createAppEnvVar(input: CreateAppEnvVarInput): StoredAppEnvVar {
    db.prepare(
      `
        INSERT INTO app_environment_variables (app_id, key, value, is_secret, enabled)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run(
      input.appId,
      input.key,
      input.value,
      input.isSecret ? 1 : 0,
      input.enabled ? 1 : 0
    );

    const created = getAppEnvVarByKey(input.appId, input.key);

    if (!created) {
      throw new Error(
        "App environment variable could not be loaded after creation"
      );
    }

    return created;
  }

  function updateAppEnvVar(id: number, input: UpdateAppEnvVarInput): void {
    const existing = getAppEnvVarById(id);

    if (!existing) {
      throw new Error("App environment variable not found");
    }

    db.prepare(
      `
        UPDATE app_environment_variables
        SET value = ?, is_secret = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(
      input.value ?? existing.value,
      (input.isSecret ?? existing.isSecret) ? 1 : 0,
      (input.enabled ?? existing.enabled) ? 1 : 0,
      id
    );
  }

  function deleteAppEnvVar(id: number): void {
    db.prepare(
      `DELETE FROM app_environment_variables WHERE id = ?`
    ).run(id);
  }

  return {
    listGlobalEnvVars,
    getGlobalEnvVarById,
    getGlobalEnvVarByKey,
    createGlobalEnvVar,
    updateGlobalEnvVar,
    deleteGlobalEnvVar,
    listAppEnvVars,
    getAppEnvVarById,
    getAppEnvVarByKey,
    createAppEnvVar,
    updateAppEnvVar,
    deleteAppEnvVar
  };
}

export type EnvironmentRepository = ReturnType<
  typeof createEnvironmentRepository
>;
