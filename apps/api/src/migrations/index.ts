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
  migration016AppDeployments
];

interface SchemaMigrationRow {
  version: number;
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
