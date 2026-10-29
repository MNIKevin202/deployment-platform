import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, type EncryptionKeyStatus } from "../services/crypto-service.js";
import {
  analyzeDependencies,
  findAppDependencies,
  type DependencyAnalysis,
  type Operation
} from "./dependencies.js";
import { appRef, type PlatformFacts } from "./facts.js";
import { openReadOnly } from "./inventory.js";

/**
 * The application DEFINITION artifact: everything ClovaForge's database knows about
 * one app, as JSON, so an application-scope import can recreate it on a server that
 * has its own database and its own credential key.
 *
 * The definition holds SECRETS IN THE CLEAR (environment values, decrypted provider
 * credentials). That is acceptable ONLY because it is written into the encrypted
 * bundle and nowhere else — it is never logged, printed or placed in a report.
 * Credentials are decrypted with the source key in memory so the destination can
 * re-encrypt them with its own key; the key itself is never exported at app scope.
 *
 * Read-only: SELECT statements on a read-only handle.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRow = Record<string, JsonValue>;

export interface UnexportedItem {
  kind: "bind-mount" | "unrecorded-volume" | "github-app-installation";
  /** Container path, or a provider name. */
  destination: string;
  detail: string;
}

export interface AppDefinition {
  definitionVersion: 1;
  app: JsonRow;
  environment: JsonRow[];
  volumes: JsonRow[];
  publishedPorts: JsonRow[];
  cronJobs: JsonRow[];
  healthCheck: JsonRow | null;
  source: JsonRow | null;
  deployments: JsonRow[];
  /** Enabled global variables this app inherits (not overridden by an app variable). */
  effectiveGlobalEnvironment: JsonRow[];
  credentials: Array<{
    provider: string;
    authenticatedUsername: string | null;
    permissionsJson: string | null;
    /** Decrypted with the SOURCE key, to be re-encrypted with the destination's. */
    secret: string;
  }>;
  /** Things the app uses that this export does NOT carry. Never silently dropped. */
  unexported: UnexportedItem[];
  dependencies: {
    strong: string[];
    weak: string[];
    analysis: DependencyAnalysis;
  };
}

export class CredentialUnavailableError extends Error {
  constructor(provider: string, reason: string) {
    super(`The stored ${provider} credential cannot be exported: ${reason}`);
    this.name = "CredentialUnavailableError";
  }
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array) {
    return { $base64: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  return String(value);
}

function jsonRow(row: Record<string, unknown>): JsonRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonValue(value)]));
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function rowsFor(db: DatabaseSync, table: string, appId: number): JsonRow[] {
  if (!tableExists(db, table)) {
    return [];
  }
  const sql = `SELECT * FROM ${table} WHERE app_id = ? ORDER BY 1`;

  return (db.prepare(sql).all(appId) as unknown as Array<Record<string, unknown>>).map(jsonRow);
}

export interface ReadDefinitionInput {
  dbPath: string;
  facts: PlatformFacts;
  appId: number;
  operation: Operation;
  /** Apps migrating together (for dependency analysis). */
  selection: number[];
  encryption: EncryptionKeyStatus;
  unexported: UnexportedItem[];
}

export function readAppDefinition(input: ReadDefinitionInput): AppDefinition {
  const db = openReadOnly(input.dbPath);

  try {
    const appRow = tableExists(db, "apps")
      ? (db.prepare("SELECT * FROM apps WHERE id = ?").get(input.appId) as Record<string, unknown> | undefined)
      : undefined;
    if (!appRow) {
      throw new Error(`Application ${input.appId} was not found in the database.`);
    }

    const environment = rowsFor(db, "app_environment_variables", input.appId);
    const overridden = new Set(environment.map((row) => String(row.key)));
    const globalEnvironment = tableExists(db, "global_environment_variables")
      ? (db.prepare("SELECT * FROM global_environment_variables WHERE enabled = 1 ORDER BY key").all() as unknown as Array<
          Record<string, unknown>
        >)
          .map(jsonRow)
          .filter((row) => !overridden.has(String(row.key)))
      : [];

    const source = rowsFor(db, "app_sources", input.appId)[0] ?? null;
    const credentials: AppDefinition["credentials"] = [];
    const unexported = [...input.unexported];

    if (source && typeof source.provider === "string" && tableExists(db, "provider_credentials")) {
      const stored = db.prepare("SELECT * FROM provider_credentials WHERE provider = ?").get(source.provider) as
        | Record<string, unknown>
        | undefined;

      if (stored) {
        if (!input.encryption.available) {
          throw new CredentialUnavailableError(source.provider, `the encryption key is unavailable (${input.encryption.reason})`);
        }
        let secret: string;
        try {
          secret = decryptSecret(input.encryption.key, String(stored.encrypted_payload));
        } catch {
          throw new CredentialUnavailableError(source.provider, "it cannot be decrypted with the current key");
        }
        credentials.push({
          provider: source.provider,
          authenticatedUsername: typeof stored.authenticated_username === "string" ? stored.authenticated_username : null,
          permissionsJson: typeof stored.permissions_json === "string" ? stored.permissions_json : null,
          secret
        });
      }
    }

    if (source && tableExists(db, "github_app_installations")) {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM github_app_installations").get() as { n: number | bigint }).n;
      if (Number(count) > 0) {
        unexported.push({
          kind: "github-app-installation",
          destination: "github",
          detail:
            "This server is connected to GitHub through a GitHub App installation. Installations are tied to this " +
            "server's app registration and are not exported; connect GitHub again on the destination."
        });
      }
    }

    const dependencies = findAppDependencies(input.facts, input.appId);

    return {
      definitionVersion: 1,
      app: jsonRow(appRow),
      environment,
      volumes: rowsFor(db, "app_volumes", input.appId),
      publishedPorts: rowsFor(db, "app_published_ports", input.appId),
      cronJobs: rowsFor(db, "cron_jobs", input.appId),
      healthCheck: rowsFor(db, "app_health_checks", input.appId)[0] ?? null,
      source,
      deployments: rowsFor(db, "app_deployments", input.appId),
      effectiveGlobalEnvironment: globalEnvironment,
      credentials,
      unexported,
      dependencies: {
        strong: dependencies.strong.map(appRef),
        weak: dependencies.weak.map(appRef),
        analysis: analyzeDependencies(input.facts, input.appId, {
          operation: input.operation,
          selection: input.selection
        })
      }
    };
  } finally {
    db.close();
  }
}
