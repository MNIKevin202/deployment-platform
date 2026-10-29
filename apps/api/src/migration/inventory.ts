import { DatabaseSync } from "node:sqlite";
import type {
  AppFacts,
  CronFacts,
  DatabaseConnectionFacts,
  DeploymentFacts,
  EnvEntry,
  PlatformFacts
} from "./facts.js";

/**
 * Reads the platform database for migration preflight — STRICTLY read-only.
 *
 * The normal application opener (`createAppDatabase`) runs schema migrations on
 * open, so it must never be pointed at a source being inspected. This module
 * opens the file `readOnly`, additionally sets `PRAGMA query_only`, and issues
 * only SELECT and two read-only PRAGMAs. A test scans this file to keep it that
 * way and another proves a write attempt on the handle throws.
 *
 * Every table is optional: an older database may lack newer tables, and a
 * missing table simply yields an empty list rather than an error.
 */

type Row = Record<string, unknown>;

/**
 * Opens the database read-only. `queryOnly` (the default) additionally sets
 * `PRAGMA query_only`. The snapshot step passes `queryOnly: false` because
 * `VACUUM INTO` is refused under query_only; the handle is STILL read-only, and
 * VACUUM INTO writes only to its own new output file.
 */
export function openReadOnly(dbPath: string, options: { queryOnly?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  if (options.queryOnly !== false) {
    db.exec("PRAGMA query_only = ON");
  }

  return db;
}

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const strOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" ? value : fallback);
const numOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);
const flag = (value: unknown): boolean => value === 1 || value === true || value === 1n;

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}

function rowsOf(db: DatabaseSync, table: string, sql: string): Row[] {
  return tableExists(db, table) ? (db.prepare(sql).all() as unknown as Row[]) : [];
}

function envEntry(row: Row): EnvEntry {
  return {
    key: str(row.key),
    value: str(row.value),
    isSecret: flag(row.is_secret),
    enabled: row.enabled === undefined ? true : flag(row.enabled)
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => number): Map<number, T[]> {
  const grouped = new Map<number, T[]>();

  for (const item of items) {
    const key = keyOf(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }

  return grouped;
}

export function readPlatformFacts(dbPath: string): PlatformFacts {
  const db = openReadOnly(dbPath);

  try {
    const schemaVersion = tableExists(db, "schema_migrations")
      ? num((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as Row | undefined)?.v)
      : 0;

    const integrityRows = db.prepare("PRAGMA quick_check").all() as unknown as Row[];
    const integrityCheck =
      integrityRows
        .map((row) => str(Object.values(row)[0]))
        .slice(0, 5)
        .join("; ") || "unknown";

    const envByApp = groupBy(
      rowsOf(
        db,
        "app_environment_variables",
        "SELECT app_id, key, value, is_secret, enabled FROM app_environment_variables ORDER BY key"
      ).map((row) => ({ appId: num(row.app_id), entry: envEntry(row) })),
      (item) => item.appId
    );
    const volumesByApp = groupBy(
      rowsOf(db, "app_volumes", "SELECT app_id, volume_name, container_path, read_only FROM app_volumes ORDER BY id").map(
        (row) => ({
          appId: num(row.app_id),
          volumeName: str(row.volume_name),
          containerPath: str(row.container_path),
          readOnly: flag(row.read_only)
        })
      ),
      (item) => item.appId
    );
    const portsByApp = groupBy(
      rowsOf(
        db,
        "app_published_ports",
        "SELECT app_id, host_port, container_port, protocol FROM app_published_ports ORDER BY id"
      ).map((row) => ({
        appId: num(row.app_id),
        hostPort: num(row.host_port),
        containerPort: num(row.container_port),
        protocol: str(row.protocol, "tcp")
      })),
      (item) => item.appId
    );
    const cronByApp = groupBy(
      rowsOf(
        db,
        "cron_jobs",
        "SELECT id, app_id, name, cron_expression, command, enabled FROM cron_jobs ORDER BY id"
      ).map((row) => ({
        appId: num(row.app_id),
        job: {
          id: num(row.id),
          name: str(row.name),
          cronExpression: str(row.cron_expression),
          enabled: flag(row.enabled),
          command: str(row.command)
        } satisfies CronFacts
      })),
      (item) => item.appId
    );
    const deploymentsByApp = groupBy(
      rowsOf(
        db,
        "app_deployments",
        "SELECT app_id, version, image_tag, source_kind, is_current FROM app_deployments ORDER BY version DESC"
      ).map((row) => ({
        appId: num(row.app_id),
        deployment: {
          version: num(row.version),
          imageTag: str(row.image_tag),
          isCurrent: flag(row.is_current),
          sourceKind: str(row.source_kind, "image")
        } satisfies DeploymentFacts
      })),
      (item) => item.appId
    );
    const sources = new Map(
      rowsOf(db, "app_sources", "SELECT * FROM app_sources").map((row) => [num(row.app_id), row] as const)
    );
    const health = new Map(
      rowsOf(db, "app_health_checks", "SELECT app_id, enabled FROM app_health_checks").map(
        (row) => [num(row.app_id), flag(row.enabled)] as const
      )
    );

    const apps: AppFacts[] = rowsOf(db, "apps", "SELECT * FROM apps ORDER BY id").map((row) => {
      const id = num(row.id);
      const name = str(row.name);
      const source = sources.get(id);

      return {
        id,
        name,
        containerName: str(row.container_name, `app-${name}`),
        image: str(row.image),
        domain: strOrNull(row.domain),
        internalOnly: flag(row.internal_only),
        desiredStatus: str(row.desired_status, "running"),
        restartPolicy: str(row.restart_policy, "unless-stopped"),
        memoryLimitMb: numOrNull(row.memory_limit_mb),
        cpuLimit: numOrNull(row.cpu_limit),
        env: (envByApp.get(id) ?? []).map((item) => item.entry),
        volumes: (volumesByApp.get(id) ?? []).map(({ volumeName, containerPath, readOnly }) => ({
          volumeName,
          containerPath,
          readOnly
        })),
        publishedPorts: (portsByApp.get(id) ?? []).map(({ hostPort, containerPort, protocol }) => ({
          hostPort,
          containerPort,
          protocol
        })),
        cronJobs: (cronByApp.get(id) ?? []).map((item) => item.job),
        source: source
          ? {
              provider: str(source.provider),
              repositoryOwner: str(source.repository_owner),
              repositoryName: str(source.repository_name),
              branch: str(source.branch),
              deploymentMode: str(source.deployment_mode),
              autoDeploy: flag(source.auto_deploy)
            }
          : null,
        deployments: (deploymentsByApp.get(id) ?? []).map((item) => item.deployment),
        healthCheck: health.has(id) ? { enabled: health.get(id) === true } : null
      };
    });

    const credentialRows = rowsOf(db, "provider_credentials", "SELECT provider, encrypted_payload FROM provider_credentials");
    const connections: DatabaseConnectionFacts[] = rowsOf(
      db,
      "database_connections",
      "SELECT id, name, kind, env_key FROM database_connections ORDER BY id"
    ).map((row) => ({
      id: num(row.id),
      name: str(row.name),
      kind: str(row.kind),
      envKey: strOrNull(row.env_key)
    }));

    const lastUpdateRow = rowsOf(
      db,
      "platform_update_history",
      "SELECT result, to_version, finished_at FROM platform_update_history ORDER BY id DESC LIMIT 1"
    )[0];

    return {
      schemaVersion,
      integrityCheck,
      apps,
      globalEnv: rowsOf(
        db,
        "global_environment_variables",
        "SELECT key, value, is_secret, enabled FROM global_environment_variables ORDER BY key"
      ).map(envEntry),
      databaseConnections: connections,
      credentialProviders: credentialRows.map((row) => str(row.provider)),
      credentialPayloads: credentialRows.map((row) => ({
        provider: str(row.provider),
        encryptedPayload: str(row.encrypted_payload)
      })),
      settingKeys: rowsOf(db, "platform_settings", "SELECT key FROM platform_settings ORDER BY key").map((row) =>
        str(row.key)
      ),
      activeDeploymentLockAppIds: rowsOf(db, "github_deployment_locks", "SELECT app_id FROM github_deployment_locks").map(
        (row) => num(row.app_id)
      ),
      lastUpdate: lastUpdateRow
        ? {
            result: str(lastUpdateRow.result),
            toVersion: str(lastUpdateRow.to_version),
            finishedAt: strOrNull(lastUpdateRow.finished_at)
          }
        : null
    };
  } finally {
    db.close();
  }
}
