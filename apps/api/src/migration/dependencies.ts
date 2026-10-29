import { appRef, type AppFacts, type EnvEntry, type PlatformFacts } from "./facts.js";

/**
 * Dependency and side-effect analysis for application-scope migration
 * (docs/MIGRATION_DESIGN.md §6.2). Pure: facts in, findings out.
 *
 * SECURITY: environment VALUES are scanned in memory to detect references to
 * other apps, but findings only ever name the variable KEY and the referenced
 * app. A value never appears in a finding, an evidence string or a remedy.
 */

export type Operation = "copy" | "move";

export type FindingKind =
  | "app"
  | "global-env"
  | "external-database"
  | "credential"
  | "published-port"
  | "domain"
  | "resource-limit"
  | "version-history";

export type FindingHandling = "must-move-together" | "reconfigure" | "acknowledge" | "info";
export type FindingSeverity = "blocker" | "warning" | "info";

export interface DependencyFinding {
  /** Stable id so a wizard can track acknowledgement of each finding. */
  id: string;
  direction: "uses" | "used-by" | "inherits" | "external" | "resource";
  kind: FindingKind;
  /** Ref of the other app involved, if any. */
  relatedApp: string | null;
  name: string;
  handling: FindingHandling;
  severity: FindingSeverity;
  /** What was found. Names variables and apps; never values. */
  evidence: string;
  remedy?: string;
}

export type SideEffectKind =
  | "cron"
  | "auto-deploy"
  | "health-check"
  | "published-port"
  | "public-domain"
  | "external-database";

/** Something that could fire on BOTH servers if a non-owner copy were allowed to run it. */
export interface SideEffect {
  kind: SideEffectKind;
  description: string;
  names: string[];
  /** Heuristic: may reach services outside this server. */
  mayContactExternal: boolean;
  /** Always true: a non-owner copy keeps every side effect off. */
  disabledOnNonOwner: true;
}

export interface DependencyAnalysis {
  application: { id: number; name: string };
  operation: Operation;
  /** App ids being migrated together (always includes the target). */
  selection: number[];
  findings: DependencyFinding[];
  /** Refs of apps that would need to join the migration to resolve a blocker. */
  suggestedAdditions: string[];
  sideEffects: SideEffect[];
  blockers: number;
  warnings: number;
}

const EXTERNAL_CONTACT = /\b(curl|wget|ssh|scp|rsync|sendmail|mail|aws|gsutil|rclone)\b|https?:\/\//i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches `token` as a whole hostname: not preceded or followed by name
 * characters, and not the first label of a longer dotted name (so "app-db"
 * matches "postgres://app-db:5432" but neither "app-db2" nor "app-db.example.com").
 */
function hostnameMatcher(token: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(token)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "i");
}

interface Reference {
  key: string;
  strength: "strong" | "weak";
}

/** Which enabled entries reference `app`, by Docker DNS name (strong) or app name (weak). */
function referencesTo(entries: EnvEntry[], app: Pick<AppFacts, "name" | "containerName">): Reference[] {
  const strong = hostnameMatcher(app.containerName);
  const weak = app.name.length >= 3 && app.name !== app.containerName ? hostnameMatcher(app.name) : null;
  const found = new Map<string, Reference>();

  for (const entry of entries) {
    if (!entry.enabled) {
      continue;
    }
    if (strong.test(entry.value)) {
      found.set(entry.key, { key: entry.key, strength: "strong" });
    } else if (weak?.test(entry.value) && !found.has(entry.key)) {
      found.set(entry.key, { key: entry.key, strength: "weak" });
    }
  }

  return [...found.values()];
}

function effectiveEnv(app: AppFacts, globalEnv: EnvEntry[]): EnvEntry[] {
  const own = new Set(app.env.map((entry) => entry.key));

  return [...app.env, ...globalEnv.filter((entry) => !own.has(entry.key))];
}

/** Apps that `app` references (strongly), for populating the manifest's `dependsOn`. */
export function findAppDependencies(facts: PlatformFacts, appId: number): { strong: number[]; weak: number[] } {
  const app = facts.apps.find((candidate) => candidate.id === appId);
  const result = { strong: [] as number[], weak: [] as number[] };

  if (!app) {
    return result;
  }

  const env = effectiveEnv(app, facts.globalEnv);
  for (const other of facts.apps) {
    if (other.id === appId) {
      continue;
    }
    const refs = referencesTo(env, other);
    if (refs.some((ref) => ref.strength === "strong")) {
      result.strong.push(other.id);
    } else if (refs.length > 0) {
      result.weak.push(other.id);
    }
  }

  return result;
}

export function analyzeDependencies(
  facts: PlatformFacts,
  appId: number,
  options: { operation: Operation; selection?: number[] }
): DependencyAnalysis {
  const target = facts.apps.find((candidate) => candidate.id === appId);
  if (!target) {
    throw new Error(`Application ${appId} was not found.`);
  }

  const operation = options.operation;
  const selection = [...new Set([appId, ...(options.selection ?? [])])].sort((a, b) => a - b);
  const selected = new Set(selection);
  const findings: DependencyFinding[] = [];
  const suggested = new Set<string>();
  const env = effectiveEnv(target, facts.globalEnv);

  for (const other of facts.apps) {
    if (other.id === appId) {
      continue;
    }

    const otherRef = appRef(other.id);
    const together = selected.has(other.id);

    // --- target uses other -------------------------------------------------
    for (const ref of referencesTo(env, other)) {
      const fromGlobal = !target.env.some((entry) => entry.key === ref.key);
      const where = fromGlobal ? `global environment variable ${ref.key}` : `environment variable ${ref.key}`;

      if (together) {
        findings.push({
          id: `uses:${otherRef}:${ref.key}`,
          direction: "uses",
          kind: "app",
          relatedApp: otherRef,
          name: other.name,
          handling: "info",
          severity: "info",
          evidence: `${where} references "${other.containerName}", which is migrating together with this app.`
        });
      } else if (ref.strength === "weak") {
        findings.push({
          id: `uses:${otherRef}:${ref.key}`,
          direction: "uses",
          kind: "app",
          relatedApp: otherRef,
          name: other.name,
          handling: "acknowledge",
          severity: "warning",
          evidence: `${where} may reference the app "${other.name}" (matched by app name, not container name).`,
          remedy: `Confirm whether ${ref.key} points at "${other.name}"; if so include it or repoint the variable.`
        });
      } else {
        suggested.add(otherRef);
        findings.push({
          id: `uses:${otherRef}:${ref.key}`,
          direction: "uses",
          kind: "app",
          relatedApp: otherRef,
          name: other.name,
          handling: other.internalOnly ? "must-move-together" : "reconfigure",
          severity: "blocker",
          evidence:
            `${where} addresses "${other.containerName}" over this server's private Docker network, ` +
            "which the destination server cannot reach.",
          remedy: other.internalOnly
            ? `Include "${other.name}" in this migration, or change ${ref.key} to an address the destination can reach.`
            : `Change ${ref.key} to "${other.name}"'s public address, or include it in this migration.`
        });
      }
    }

    // --- other uses target -------------------------------------------------
    const dependents = [
      ...referencesTo(other.env, target).map((ref) => ({ ...ref, scope: "app" as const })),
      ...referencesTo(
        facts.globalEnv.filter((entry) => !other.env.some((own) => own.key === entry.key)),
        target
      ).map((ref) => ({ ...ref, scope: "global" as const }))
    ];

    for (const ref of dependents) {
      const where =
        ref.scope === "global"
          ? `global environment variable ${ref.key}`
          : `"${other.name}" environment variable ${ref.key}`;

      if (together) {
        findings.push({
          id: `used-by:${otherRef}:${ref.key}`,
          direction: "used-by",
          kind: "app",
          relatedApp: otherRef,
          name: other.name,
          handling: "info",
          severity: "info",
          evidence: `${where} references this app; "${other.name}" is migrating together with it.`
        });
        continue;
      }

      const breaks = operation === "move";
      findings.push({
        id: `used-by:${otherRef}:${ref.key}`,
        direction: "used-by",
        kind: "app",
        relatedApp: otherRef,
        name: other.name,
        handling: breaks ? (ref.strength === "strong" ? "reconfigure" : "acknowledge") : "info",
        severity: !breaks ? "info" : ref.strength === "strong" ? "blocker" : "warning",
        evidence:
          `${where} references this app` +
          (ref.strength === "weak" ? " (matched by app name)" : "") +
          (breaks ? "; it will stop finding it once this app moves." : "; the original keeps running, so nothing breaks."),
        remedy: breaks
          ? `Include "${other.name}" in this migration, or repoint ${ref.key} to the app's new address.`
          : undefined
      });
      if (breaks && ref.strength === "strong") {
        suggested.add(otherRef);
      }
    }
  }

  // --- inherited global environment ---------------------------------------
  const inherited = facts.globalEnv.filter(
    (entry) => entry.enabled && !target.env.some((own) => own.key === entry.key)
  );
  if (inherited.length > 0) {
    const names = inherited.map((entry) => entry.key).sort();
    findings.push({
      id: "inherits:global-env",
      direction: "inherits",
      kind: "global-env",
      relatedApp: null,
      name: "Global environment",
      handling: "info",
      severity: "info",
      evidence:
        `${names.length} global variable(s) apply to this app (${names.slice(0, 20).join(", ")}` +
        `${names.length > 20 ? ", …" : ""}). They are carried as part of the app's effective environment; ` +
        "the destination's own global variables are not modified."
    });
  }

  // --- external databases ---------------------------------------------------
  const externalKeys = new Map<string, { name: string; kind: string }>();
  for (const connection of facts.databaseConnections) {
    if (connection.envKey) {
      externalKeys.set(connection.envKey, { name: connection.name, kind: connection.kind });
    }
  }
  for (const entry of env) {
    const connection = externalKeys.get(entry.key);
    if (connection && entry.enabled) {
      findings.push({
        id: `external-db:${entry.key}`,
        direction: "external",
        kind: "external-database",
        relatedApp: null,
        name: connection.name,
        handling: "acknowledge",
        severity: "warning",
        evidence:
          `${entry.key} points at the external ${connection.kind} database "${connection.name}". ` +
          "If both servers ran this app at once, both would write to that database.",
        remedy: "The copy stays dormant until you explicitly promote it, so only one server writes at a time."
      });
    }
  }

  // --- credentials ------------------------------------------------------------
  if (target.source) {
    findings.push({
      id: `credential:${target.source.provider}`,
      direction: "uses",
      kind: "credential",
      relatedApp: null,
      name: `${target.source.provider} credential`,
      handling: "acknowledge",
      severity: "info",
      evidence:
        `Builds from ${target.source.repositoryOwner}/${target.source.repositoryName} using the stored ` +
        `${target.source.provider} credential.`,
      remedy:
        "The credential is re-encrypted for the destination's own key (the key itself is never transferred); " +
        "or re-authenticate on the destination instead."
    });
  }

  // --- host-level resources ---------------------------------------------------
  for (const port of target.publishedPorts) {
    findings.push({
      id: `port:${port.hostPort}/${port.protocol}`,
      direction: "resource",
      kind: "published-port",
      relatedApp: null,
      name: `${port.hostPort}/${port.protocol}`,
      handling: "info",
      severity: "info",
      evidence: `Publishes host port ${port.hostPort}/${port.protocol}; it must be free on the destination.`
    });
  }

  if (target.domain && !target.internalOnly) {
    findings.push({
      id: "domain",
      direction: "resource",
      kind: "domain",
      relatedApp: null,
      name: target.domain,
      handling: operation === "copy" ? "acknowledge" : "info",
      severity: operation === "copy" ? "warning" : "info",
      evidence:
        operation === "copy"
          ? `A domain can only point at one server. The copy needs a different domain (or none) while "${target.domain}" stays on the source.`
          : `"${target.domain}" must be repointed to the destination at cutover.`,
      remedy: operation === "move" ? "Lower the DNS TTL ahead of time to shorten the switch-over." : undefined
    });
  }

  if (target.memoryLimitMb !== null || target.cpuLimit !== null) {
    findings.push({
      id: "resource-limits",
      direction: "resource",
      kind: "resource-limit",
      relatedApp: null,
      name: "Resource limits",
      handling: "info",
      severity: "info",
      evidence:
        `Limits: ${target.memoryLimitMb !== null ? `${target.memoryLimitMb} MiB memory` : "no memory limit"}, ` +
        `${target.cpuLimit !== null ? `${target.cpuLimit} CPU` : "no CPU limit"}. The destination needs that capacity.`
    });
  }

  const retained = target.deployments.filter((deployment) => deployment.sourceKind === "github");
  if (retained.length > 0) {
    findings.push({
      id: "version-history",
      direction: "resource",
      kind: "version-history",
      relatedApp: null,
      name: "Version history",
      handling: "info",
      severity: "info",
      evidence:
        `${retained.length} retained build(s) support rollback. Their images exist only on this server, ` +
        "so they must be carried over for rollback to keep working on the destination."
    });
  }

  return {
    application: { id: target.id, name: target.name },
    operation,
    selection,
    findings,
    suggestedAdditions: [...suggested].sort(),
    sideEffects: sideEffectsOf(target, externalKeys),
    blockers: findings.filter((finding) => finding.severity === "blocker").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length
  };
}

function sideEffectsOf(
  app: AppFacts,
  externalKeys: Map<string, { name: string; kind: string }>
): SideEffect[] {
  const effects: SideEffect[] = [];

  const cron = app.cronJobs.filter((job) => job.enabled);
  if (cron.length > 0) {
    effects.push({
      kind: "cron",
      description: `${cron.length} enabled scheduled command(s) run inside this app's container.`,
      names: cron.map((job) => job.name),
      mayContactExternal: cron.some((job) => EXTERNAL_CONTACT.test(job.command)),
      disabledOnNonOwner: true
    });
  }

  if (app.source?.autoDeploy) {
    effects.push({
      kind: "auto-deploy",
      description:
        `Auto-deploy watches ${app.source.repositoryOwner}/${app.source.repositoryName}@${app.source.branch}. ` +
        "Two servers watching one repository would both deploy every push.",
      names: [`${app.source.repositoryOwner}/${app.source.repositoryName}`],
      mayContactExternal: true,
      disabledOnNonOwner: true
    });
  }

  if (app.healthCheck?.enabled) {
    effects.push({
      kind: "health-check",
      description: "Health checks probe the app and may restart it or send notifications.",
      names: [app.name],
      mayContactExternal: false,
      disabledOnNonOwner: true
    });
  }

  if (app.publishedPorts.length > 0) {
    effects.push({
      kind: "published-port",
      description: "Publishes raw host ports that external clients connect to.",
      names: app.publishedPorts.map((port) => `${port.hostPort}/${port.protocol}`),
      mayContactExternal: false,
      disabledOnNonOwner: true
    });
  }

  if (app.domain && !app.internalOnly) {
    effects.push({
      kind: "public-domain",
      description: "Serves public traffic on its domain through the reverse proxy.",
      names: [app.domain],
      mayContactExternal: false,
      disabledOnNonOwner: true
    });
  }

  const externalHits = app.env.filter((entry) => entry.enabled && externalKeys.has(entry.key));
  if (externalHits.length > 0) {
    effects.push({
      kind: "external-database",
      description: "Writes to an external database that the other server's copy would also reach.",
      names: externalHits.map((entry) => entry.key),
      mayContactExternal: true,
      disabledOnNonOwner: true
    });
  }

  return effects;
}
