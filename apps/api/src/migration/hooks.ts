import { z } from "zod";
import type { DataProfileKind } from "./consistency.js";
import type { ExportDockerClient } from "./export-docker.js";

/**
 * Application-level snapshot HOOKS: the only route (besides a verified clean
 * shutdown) to an `application-consistent` export.
 *
 * A hook runs a dump command INSIDE the running app's container and streams its
 * output into the bundle. The dump only counts as evidence if it is VERIFIED:
 *
 *   1. the command exited 0,
 *   2. it produced at least a plausible number of bytes, and
 *   3. the end of the stream carries the tool's own completion marker — a
 *      truncated dump would not.
 *
 * Built-in presets exist only where such a marker exists (PostgreSQL, MySQL,
 * MariaDB). Where one does not (MongoDB, Redis, anything unknown) there is
 * deliberately no preset: the operator supplies a hook that states how its
 * output is verified, or accepts the weaker level explicitly.
 */

export interface HookDefinition {
  id: string;
  description: string;
  /** Run inside the container via `exec`; stdout is the dump. */
  cmd: string[];
  user?: string;
  /** Regex SOURCE the end of the output must match. Required unless `exitStatusOnly`. */
  trailer?: string;
  /** The operator explicitly accepts "exit status 0 and non-empty" as the only check. Recorded as such. */
  exitStatusOnly?: boolean;
  minBytes: number;
  /** Informational label for the artifact (e.g. "sql"). */
  format: string;
  /**
   * Container paths whose volumes this dump fully replaces. A prefix match; "*" means
   * every volume of the app. A volume not covered cannot be consistent via this hook.
   */
  covers: string[];
}

const POSTGRES: HookDefinition = {
  id: "postgres",
  description: "pg_dumpall (plain SQL), verified by its completion marker",
  cmd: ["sh", "-c", 'PGPASSWORD="${POSTGRES_PASSWORD:-}" exec pg_dumpall -U "${POSTGRES_USER:-postgres}"'],
  trailer: "-- PostgreSQL database cluster dump complete",
  minBytes: 100,
  format: "sql",
  covers: ["/var/lib/postgresql", "/bitnami/postgresql"]
};

const MYSQL_DUMP_ARGS = "--all-databases --single-transaction --routines --events --triggers -uroot";

const MYSQL: HookDefinition = {
  id: "mysql",
  description: "mysqldump --single-transaction (InnoDB snapshot), verified by its completion marker",
  cmd: ["sh", "-c", `MYSQL_PWD="\${MYSQL_ROOT_PASSWORD:-}" exec mysqldump ${MYSQL_DUMP_ARGS}`],
  trailer: "-- Dump completed on",
  minBytes: 100,
  format: "sql",
  covers: ["/var/lib/mysql"]
};

const MARIADB: HookDefinition = {
  id: "mariadb",
  description: "mariadb-dump --single-transaction (InnoDB snapshot), verified by its completion marker",
  cmd: [
    "sh",
    "-c",
    'export MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}"; ' +
      `if command -v mariadb-dump >/dev/null 2>&1; then exec mariadb-dump ${MYSQL_DUMP_ARGS}; else exec mysqldump ${MYSQL_DUMP_ARGS}; fi`
  ],
  trailer: "-- Dump completed on",
  minBytes: 100,
  format: "sql",
  covers: ["/var/lib/mysql"]
};

/** The built-in hook for a data profile, or null where no verifiable preset exists. */
export function presetFor(kind: DataProfileKind): HookDefinition | null {
  switch (kind) {
    case "postgres":
      return POSTGRES;
    case "mysql":
      return MYSQL;
    case "mariadb":
      return MARIADB;
    default:
      return null;
  }
}

/** True if `hook` replaces the volume mounted at `containerPath`. */
export function hookCovers(hook: HookDefinition, containerPath: string): boolean {
  return hook.covers.some(
    (path) => path === "*" || containerPath === path || containerPath.startsWith(`${path.replace(/\/$/, "")}/`)
  );
}

// ------------------------------------------------------------ operator hooks ----

const customHookSchema = z
  .strictObject({
    cmd: z.array(z.string().min(1)).min(1).max(64),
    user: z.string().max(64).optional(),
    trailer: z.string().min(1).max(500).optional(),
    exitStatusOnly: z.boolean().optional(),
    minBytes: z.number().int().nonnegative().max(2 ** 40).default(1),
    format: z.string().max(32).default("dump"),
    covers: z.array(z.string().min(1).max(4096)).min(1).max(64).default(["*"])
  })
  .superRefine((hook, context) => {
    if (!hook.trailer && !hook.exitStatusOnly) {
      context.addIssue({
        code: "custom",
        message:
          'A hook must say how its output is verified: give a "trailer" (a regex the end of the output must match) ' +
          'or set "exitStatusOnly": true to accept exit status alone, knowingly.',
        path: ["trailer"]
      });
    }
    if (hook.trailer) {
      try {
        new RegExp(hook.trailer, "m");
      } catch {
        context.addIssue({ code: "custom", message: "The trailer is not a valid regular expression.", path: ["trailer"] });
      }
    }
  });

export type HooksFile = Record<string, HookDefinition>;

/** Parses an operator's hooks file: `{ "<app name or ref>": { cmd, trailer, … } }`. */
export function parseHooksFile(text: string): HooksFile {
  const parsed = z.record(z.string().min(1).max(255), customHookSchema).parse(JSON.parse(text));
  const hooks: HooksFile = {};

  for (const [key, hook] of Object.entries(parsed)) {
    hooks[key] = { id: "custom", description: "operator-defined hook", ...hook };
  }

  return hooks;
}

// ------------------------------------------------------------- verification ----

export class HookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookVerificationError";
  }
}

export interface DumpResult {
  exitCode: number;
  bytes: number;
  /** The last few KiB of the dump. */
  tail: string;
  stderr: string;
}

export interface DumpVerdict {
  ok: boolean;
  /** Human-readable, secret-free. Becomes the evidence detail on success. */
  detail: string;
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function verifyDump(hook: HookDefinition, result: DumpResult): DumpVerdict {
  if (result.exitCode !== 0) {
    return {
      ok: false,
      detail: `the dump command exited with status ${result.exitCode}${result.stderr ? ` (${snippet(result.stderr)})` : ""}`
    };
  }
  if (result.bytes < hook.minBytes) {
    return { ok: false, detail: `the dump is only ${result.bytes} byte(s); at least ${hook.minBytes} were expected` };
  }

  if (hook.trailer) {
    if (!new RegExp(hook.trailer, "m").test(result.tail)) {
      return {
        ok: false,
        detail: "the dump does not end with the tool's completion marker, so it may be truncated"
      };
    }

    return {
      ok: true,
      detail: `${hook.id} dump exited 0, ${result.bytes} bytes, completion marker present`
    };
  }

  return {
    ok: true,
    detail: `${hook.id} dump exited 0, ${result.bytes} bytes (the operator accepted exit status alone as the check)`
  };
}

// ---------------------------------------------------------- clean shutdown ----

export interface ShutdownCheck {
  ok: boolean;
  detail: string;
}

/**
 * After a PostgreSQL container has been STOPPED, asks `pg_controldata` — run from the
 * app's own image against the stopped data directory, read-only — what state the
 * cluster was left in. "shut down" is the database's OWN statement that it closed
 * cleanly; "in production" (a crash or kill) is not.
 */
export async function verifyPostgresCleanShutdown(
  client: ExportDockerClient,
  input: { image: string; volumeName: string; mountPath: string; pgdata?: string; timeoutMs?: number; signal?: AbortSignal }
): Promise<ShutdownCheck> {
  const dataDir =
    input.pgdata && (input.pgdata === input.mountPath || input.pgdata.startsWith(`${input.mountPath.replace(/\/$/, "")}/`))
      ? input.pgdata
      : input.mountPath;

  const result = await client.runHelper({
    image: input.image,
    entrypoint: ["pg_controldata"],
    cmd: [dataDir],
    binds: [`${input.volumeName}:${input.mountPath}:ro`],
    timeoutMs: input.timeoutMs ?? 60_000,
    signal: input.signal
  });

  if (result.exitCode !== 0) {
    return { ok: false, detail: `pg_controldata could not read the data directory (exit ${result.exitCode})` };
  }

  const state = /^Database cluster state:\s*(.+?)\s*$/m.exec(result.stdout)?.[1];
  if (state === "shut down") {
    return { ok: true, detail: 'pg_controldata reports the cluster state "shut down"' };
  }

  return {
    ok: false,
    detail: `pg_controldata reports the cluster state "${state ?? "unknown"}", not "shut down"`
  };
}
