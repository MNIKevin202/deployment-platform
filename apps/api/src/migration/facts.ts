/**
 * Plain data describing an installation, as read (read-only) from the platform
 * database. These types are the input to dependency analysis and preflight.
 *
 * SECURITY: `EnvEntry.value` and `CronFacts.command` can contain secrets. They
 * exist in memory only so references can be detected; every analysis function
 * must emit KEY NAMES and counts, never values. Tests plant a secret value and
 * assert it never appears in any report.
 */

export interface EnvEntry {
  key: string;
  value: string;
  isSecret: boolean;
  enabled: boolean;
}

export interface VolumeFacts {
  volumeName: string;
  containerPath: string;
  readOnly: boolean;
}

export interface PublishedPortFacts {
  hostPort: number;
  containerPort: number;
  protocol: string;
}

export interface CronFacts {
  id: number;
  name: string;
  cronExpression: string;
  enabled: boolean;
  /** In-memory only — scanned for external-contact heuristics, never emitted. */
  command: string;
}

export interface SourceFacts {
  provider: string;
  repositoryOwner: string;
  repositoryName: string;
  branch: string;
  deploymentMode: string;
  autoDeploy: boolean;
}

export interface DeploymentFacts {
  version: number;
  imageTag: string;
  isCurrent: boolean;
  sourceKind: string;
}

export interface HealthCheckFacts {
  enabled: boolean;
}

export interface AppFacts {
  id: number;
  name: string;
  containerName: string;
  image: string;
  domain: string | null;
  internalOnly: boolean;
  desiredStatus: string;
  restartPolicy: string;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  env: EnvEntry[];
  volumes: VolumeFacts[];
  publishedPorts: PublishedPortFacts[];
  cronJobs: CronFacts[];
  source: SourceFacts | null;
  deployments: DeploymentFacts[];
  healthCheck: HealthCheckFacts | null;
}

export interface DatabaseConnectionFacts {
  id: number;
  name: string;
  kind: string;
  /** The env var the connection is exposed as, if pushed to the global environment. */
  envKey: string | null;
}

export interface PlatformFacts {
  /** Highest applied schema migration. */
  schemaVersion: number;
  /** Result of PRAGMA quick_check ("ok" or a diagnostic). */
  integrityCheck: string;
  apps: AppFacts[];
  globalEnv: EnvEntry[];
  databaseConnections: DatabaseConnectionFacts[];
  /** Providers with a stored (encrypted) credential. */
  credentialProviders: string[];
  /** Raw encrypted payloads, for decryptability checks only. Never emitted. */
  credentialPayloads: Array<{ provider: string; encryptedPayload: string }>;
  settingKeys: string[];
  /** App ids with a deployment lock currently held. */
  activeDeploymentLockAppIds: number[];
  /** Most recent self-update attempt, if any. */
  lastUpdate: { result: string; toVersion: string; finishedAt: string | null } | null;
}

export function appRef(appId: number): string {
  return `app:${appId}`;
}
