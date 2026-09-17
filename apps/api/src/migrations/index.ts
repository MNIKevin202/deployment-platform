import type { DatabaseSync } from "node:sqlite";
import { migration001InitialSchema } from "./001_initial_schema.js";
import { migration002ExpandAppsColumns } from "./002_expand_apps_columns.js";
import { migration003EnvironmentVariables } from "./003_environment_variables.js";
import { migration004AppVolumes } from "./004_app_volumes.js";
import { migration005AppHealthChecks } from "./005_app_health_checks.js";
import { migration006AppDeploymentEvents } from "./006_app_deployment_events.js";
import { migration007ProviderCredentials } from "./007_provider_credentials.js";
import { migration008AppSources } from "./008_app_sources.js";
import { migration009AppSourceDeploymentMetadata } from "./009_app_source_deployment_metadata.js";
import { migration010SourcePortMetadata } from "./010_source_port_metadata.js";
import { migration011PerformanceDiagnostics } from "./011_performance_diagnostics.js";
import { migration012IdempotencyKeys } from "./012_idempotency_keys.js";
import { migration013InternalOnlyApps } from "./013_internal_only_apps.js";
import { migration014GithubAppInstallations } from "./014_github_app_installations.js";
import { migration015SourceSelectedStrategy } from "./015_source_selected_strategy.js";
import { migration016AppDeployments } from "./016_app_deployments.js";
import { migration017BuildLogs } from "./017_build_logs.js";
import { migration018PlatformSettings } from "./018_platform_settings.js";
import { migration019AppResourceLimits } from "./019_app_resource_limits.js";
import { migration020AppPublishedPorts } from "./020_app_published_ports.js";
import { migration021CronJobs } from "./021_cron_jobs.js";
import { migration022CronJobRuns } from "./022_cron_job_runs.js";
import { migration023AppDeploymentRetention } from "./023_app_deployment_retention.js";
import { migration024DatabaseConnections } from "./024_database_connections.js";
import { migration025DeploymentDuration } from "./025_deployment_duration.js";
import { migration026DeploymentStatus } from "./026_deployment_status.js";
import { migration027AutoDeployBlock } from "./027_auto_deploy_block.js";
import { migration028PlatformUpdateHistory } from "./028_platform_update_history.js";
import type { Migration } from "./types.js";

export type { Migration } from "./types.js";

const migrations: Migration[] = [
  migration001InitialSchema,
  migration002ExpandAppsColumns,
  migration003EnvironmentVariables,
  migration004AppVolumes,
  migration005AppHealthChecks,
  migration006AppDeploymentEvents,
  migration007ProviderCredentials,
  migration008AppSources,
  migration009AppSourceDeploymentMetadata,
  migration010SourcePortMetadata,
  migration011PerformanceDiagnostics,
  migration012IdempotencyKeys,
  migration013InternalOnlyApps,
  migration014GithubAppInstallations,
  migration015SourceSelectedStrategy,
  migration016AppDeployments,
  migration017BuildLogs,
  migration018PlatformSettings,
  migration019AppResourceLimits,
  migration020AppPublishedPorts,
  migration021CronJobs,
  migration022CronJobRuns,
  migration023AppDeploymentRetention,
  migration024DatabaseConnections,
  migration025DeploymentDuration,
  migration026DeploymentStatus,
  migration027AutoDeployBlock,
  migration028PlatformUpdateHistory
];

interface SchemaMigrationRow {
  version: number;
}

/**
 * Whether rolling the running image back to whatever it was at
 * `previousMaxVersion` (the highest migration version already applied
 * before an upgrade) would leave the database in a shape that version can
 * still understand. True only if every migration strictly newer than
 * `previousMaxVersion` is classified "expand" — see MigrationRisk in
 * types.ts. A migration this platform doesn't know about at all (should
 * never happen: the full list is baked into the image) is treated the
 * same as "breaking", never silently ignored.
 *
 * This is the authority release-remote.sh's automatic rollback consults
 * (via the API's /platform/updates status) rather than a hand-maintained
 * list in a release manifest — the actual migrations that will run for a
 * given installation depend on that installation's current version, which
 * only the installation itself (via its own schema_migrations table)
 * actually knows.
 */
export function computeRollbackSafety(previousMaxVersion: number): boolean {
  return migrations
    .filter((migration) => migration.version > previousMaxVersion)
    .every((migration) => migration.risk === "expand");
}

/** The full, ordered migration list — exposed read-only for verification/reporting (e.g. computeRollbackSafety, release-remote.sh's from-source check). */
export function listMigrations(): ReadonlyArray<Migration> {
  return [...migrations].sort((a, b) => a.version - b.version);
}

/** The highest migration version already applied to this database, or 0 if none have run yet. */
export function getAppliedMaxVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as unknown as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedVersions = new Set(
    (
      db
        .prepare("SELECT version FROM schema_migrations")
        .all() as unknown as SchemaMigrationRow[]
    ).map((row) => row.version)
  );

  const orderedMigrations = [...migrations].sort(
    (a, b) => a.version - b.version
  );

  for (const migration of orderedMigrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    db.exec("BEGIN");

    try {
      migration.up(db);

      db.prepare(
        "INSERT INTO schema_migrations (version, name) VALUES (?, ?)"
      ).run(migration.version, migration.name);

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
