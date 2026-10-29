/**
 * Application-consistency model for migration snapshots.
 *
 * The central rule: STOPPING A CONTAINER IS NOT PROOF OF AN APPLICATION-CONSISTENT
 * COPY. A clean stop only shows that the process exited; nothing shows its data
 * files are in a state the application itself would accept. That requires
 * application-level evidence (a verified dump, a verified clean-shutdown marker,
 * a passed integrity check, …). Without it the best a stop can earn is
 * `quiesced-unverified` — a deliberately separate, weaker level.
 *
 * Pure functions only: no I/O, no Docker.
 */

export const CONSISTENCY_LEVELS = [
  "application-consistent",
  "quiesced-unverified",
  "crash-consistent",
  "inconsistent",
  "not-applicable"
] as const;
export type ConsistencyLevel = (typeof CONSISTENCY_LEVELS)[number];

export const SNAPSHOT_STRATEGIES = ["stop", "freeze", "hook", "live", "none"] as const;
export type SnapshotStrategy = (typeof SNAPSHOT_STRATEGIES)[number];

export const EVIDENCE_KINDS = [
  // Process-level facts. These NEVER establish application consistency.
  "clean-exit",
  "forced-kill",
  "frozen",
  // Application-level facts. Any one of these (when applicable) does.
  "logical-dump-verified",
  "clean-shutdown-marker-verified",
  "integrity-check-passed",
  "app-snapshot-verified"
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const APPLICATION_LEVEL_EVIDENCE: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  "logical-dump-verified",
  "clean-shutdown-marker-verified",
  "integrity-check-passed",
  "app-snapshot-verified"
]);

export interface ConsistencyEvidence {
  kind: EvidenceKind;
  detail?: string;
}

export function isApplicationLevelEvidence(kind: EvidenceKind): boolean {
  return APPLICATION_LEVEL_EVIDENCE.has(kind);
}

/** Higher is stronger. `not-applicable` is handled separately. */
const RANK: Record<ConsistencyLevel, number> = {
  "application-consistent": 4,
  "quiesced-unverified": 3,
  "crash-consistent": 2,
  inconsistent: 1,
  "not-applicable": 5
};

export function meetsLevel(actual: ConsistencyLevel, required: ConsistencyLevel): boolean {
  return RANK[actual] >= RANK[required];
}

/** The weakest of several levels (`not-applicable` entries are ignored). */
export function weakestLevel(levels: ConsistencyLevel[]): ConsistencyLevel {
  const relevant = levels.filter((level) => level !== "not-applicable");

  if (relevant.length === 0) {
    return "not-applicable";
  }

  return relevant.reduce((weakest, level) => (RANK[level] < RANK[weakest] ? level : weakest));
}

export interface ClassifyInput {
  strategy: SnapshotStrategy;
  hasPersistentState: boolean;
  evidence: ConsistencyEvidence[];
}

/**
 * Classifies what was actually achieved. Evidence — not the strategy — decides.
 */
export function classifyConsistency(input: ClassifyInput): ConsistencyLevel {
  if (!input.hasPersistentState) {
    return "not-applicable";
  }

  const kinds = new Set(input.evidence.map((entry) => entry.kind));

  // A clean-shutdown marker only means something if the app was actually stopped.
  const applicationLevel = [...kinds].some(
    (kind) =>
      isApplicationLevelEvidence(kind) &&
      (kind !== "clean-shutdown-marker-verified" || input.strategy === "stop")
  );

  if (applicationLevel) {
    return "application-consistent";
  }

  if (input.strategy === "stop") {
    // Stopped and exited cleanly, but nothing verified the data: NOT consistent proof.
    if (kinds.has("clean-exit") && !kinds.has("forced-kill")) {
      return "quiesced-unverified";
    }

    // Killed (or exit status unknown): the files are as after a crash.
    return "crash-consistent";
  }

  if (input.strategy === "freeze" || kinds.has("frozen")) {
    return "crash-consistent";
  }

  // `live`, `none`, or a hook that ran but proved nothing.
  return "inconsistent";
}

/** The best level a strategy can reach WITHOUT application-level evidence. */
export function ceilingWithoutEvidence(strategy: SnapshotStrategy): ConsistencyLevel {
  switch (strategy) {
    case "stop":
      return "quiesced-unverified";
    case "freeze":
      return "crash-consistent";
    default:
      return "inconsistent";
  }
}

// ------------------------------------------------------------ data profiles ----

export const DATA_PROFILE_KINDS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongodb",
  "redis",
  "unknown-stateful",
  "stateless"
] as const;
export type DataProfileKind = (typeof DATA_PROFILE_KINDS)[number];

export interface DataProfile {
  kind: DataProfileKind;
  /** True for recognised database engines. */
  isDatabase: boolean;
  /** True when the app has persistent state of any kind. */
  hasPersistentState: boolean;
  /** Why the profile was chosen (metadata only — never volume contents). */
  reasons: string[];
  /** What an application-consistent export of this profile needs. */
  recommendation: string;
}

export interface ProfileInput {
  image: string;
  mountPaths: string[];
  /** Environment variable NAMES only — values are never inspected here. */
  envKeys: string[];
  hasVolumes: boolean;
}

const RECOMMENDATIONS: Record<DataProfileKind, string> = {
  postgres:
    "Take a logical dump (pg_dump/pg_dumpall) and verify it with pg_restore --list, or stop the " +
    "database and verify pg_controldata reports a clean shutdown.",
  mysql:
    "Take a transactional logical dump (mysqldump --single-transaction) and verify it, or stop the " +
    "database and verify a clean InnoDB shutdown.",
  mariadb:
    "Take a transactional logical dump (mariadb-dump --single-transaction) and verify it, or stop " +
    "the database and verify a clean InnoDB shutdown.",
  mongodb:
    "Take mongodump (with --oplog on a replica set) and verify it, or fsyncLock for a storage " +
    "snapshot and verify.",
  redis: "Force SAVE, then verify the dump with redis-check-rdb before copying it.",
  "unknown-stateful":
    "ClovaForge cannot tell what this volume holds. Provide an application-level hook, or explicitly " +
    "accept the risk for this app.",
  stateless: "No persistent state; nothing to make consistent."
};

function imageRepository(image: string): string {
  const withoutDigest = image.split("@")[0] ?? image;
  const lastSegment = withoutDigest.split("/").pop() ?? withoutDigest;

  return (lastSegment.split(":")[0] ?? lastSegment).toLowerCase();
}

/**
 * Classifies an app's data from METADATA ONLY (image name, mount paths, env
 * var names). It deliberately never opens volumes, so it is safe in a
 * read-only preflight. Unrecognised stateful apps become `unknown-stateful`,
 * never "assumed fine".
 */
export function classifyDataProfile(input: ProfileInput): DataProfile {
  const repo = imageRepository(input.image);
  const reasons: string[] = [];
  let kind: DataProfileKind | null = null;

  const byImage: Array<[RegExp, DataProfileKind]> = [
    [/^(postgres|postgresql|postgis|timescaledb|pgvector|pgautoupgrade)/, "postgres"],
    [/^mariadb/, "mariadb"],
    [/^(mysql|percona)/, "mysql"],
    [/^(mongo|mongodb)/, "mongodb"],
    [/^(redis|valkey|keydb|dragonfly)/, "redis"]
  ];

  for (const [pattern, candidate] of byImage) {
    if (pattern.test(repo)) {
      kind = candidate;
      reasons.push(`image name "${repo}" matches ${candidate}`);
      break;
    }
  }

  if (kind === null) {
    const paths = input.mountPaths.map((path) => path.toLowerCase());
    const byPath: Array<[string, DataProfileKind]> = [
      ["/var/lib/postgresql", "postgres"],
      ["/bitnami/postgresql", "postgres"],
      ["/var/lib/mysql", "mysql"],
      ["/data/db", "mongodb"]
    ];

    for (const [prefix, candidate] of byPath) {
      if (paths.some((path) => path === prefix || path.startsWith(`${prefix}/`))) {
        kind = candidate;
        reasons.push(`a volume is mounted at ${prefix}`);
        break;
      }
    }
  }

  if (kind === null) {
    const keys = new Set(input.envKeys.map((key) => key.toUpperCase()));
    const byEnv: Array<[string[], DataProfileKind]> = [
      [["POSTGRES_PASSWORD", "POSTGRES_USER", "POSTGRES_DB"], "postgres"],
      [["MARIADB_ROOT_PASSWORD", "MARIADB_DATABASE"], "mariadb"],
      [["MYSQL_ROOT_PASSWORD", "MYSQL_DATABASE"], "mysql"],
      [["MONGO_INITDB_ROOT_USERNAME", "MONGO_INITDB_DATABASE"], "mongodb"]
    ];

    for (const [names, candidate] of byEnv) {
      const hit = names.find((name) => keys.has(name));
      if (hit) {
        kind = candidate;
        reasons.push(`environment variable ${hit} is set`);
        break;
      }
    }
  }

  if (kind !== null) {
    return {
      kind,
      isDatabase: true,
      hasPersistentState: true,
      reasons,
      recommendation: RECOMMENDATIONS[kind]
    };
  }

  if (input.hasVolumes) {
    return {
      kind: "unknown-stateful",
      isDatabase: false,
      hasPersistentState: true,
      reasons: ["the app has persistent volumes and its data type could not be identified"],
      recommendation: RECOMMENDATIONS["unknown-stateful"]
    };
  }

  return {
    kind: "stateless",
    isDatabase: false,
    hasPersistentState: false,
    reasons: ["the app has no persistent volumes"],
    recommendation: RECOMMENDATIONS.stateless
  };
}

// ------------------------------------------------------------------ policy ----

export type ExportMode = "rehearsal" | "cutover";

export interface AcceptedRisk {
  /** Subject ref, e.g. "app:12". */
  subject: string;
  level: ConsistencyLevel;
  acceptedAt: string;
  reason?: string;
}

export interface PolicyVerdict {
  severity: "pass" | "warn" | "fail";
  /** True when the export may proceed. */
  allowed: boolean;
  /** True when proceeding requires an explicit, recorded risk acceptance. */
  requiresAcceptance: boolean;
  message: string;
}

/**
 * Decides whether an achieved (or expected) level is acceptable.
 *  - rehearsal: always allowed; weaker levels are reported, never hidden.
 *  - cutover: databases and unknown-stateful apps must be application-consistent,
 *    unless the operator explicitly accepts the risk for that app. A live,
 *    unquiesced copy (`inconsistent`) can NEVER be accepted at cutover.
 */
export function evaluateConsistencyPolicy(input: {
  profile: DataProfile;
  level: ConsistencyLevel;
  mode: ExportMode;
  accepted: boolean;
}): PolicyVerdict {
  const { profile, level, mode, accepted } = input;

  if (!profile.hasPersistentState || level === "not-applicable") {
    return { severity: "pass", allowed: true, requiresAcceptance: false, message: "No persistent state." };
  }

  if (level === "application-consistent") {
    return {
      severity: "pass",
      allowed: true,
      requiresAcceptance: false,
      message: "Application-level evidence verified the data."
    };
  }

  if (mode === "rehearsal") {
    return {
      severity: "warn",
      allowed: true,
      requiresAcceptance: false,
      message: `Rehearsal-grade only (${level}); this copy must not be used for cutover.`
    };
  }

  if (level === "inconsistent") {
    return {
      severity: "fail",
      allowed: false,
      requiresAcceptance: false,
      message:
        "A live, unquiesced copy cannot be accepted for cutover. Stop the app or use an " +
        "application-level hook."
    };
  }

  if (accepted) {
    return {
      severity: "warn",
      allowed: true,
      requiresAcceptance: false,
      message: `Proceeding on explicitly accepted risk (${level}, not application-consistent).`
    };
  }

  return {
    severity: "fail",
    allowed: false,
    requiresAcceptance: true,
    message:
      `Only ${level} could be established for this ` +
      `${profile.isDatabase ? `${profile.kind} database` : "stateful app"}. ` +
      "Cutover requires application-level evidence, or an explicit, recorded risk acceptance."
  };
}
