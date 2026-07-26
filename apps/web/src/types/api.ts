export interface DockerInfo {
  status: string;
  containers: number;
  containersRunning: number;
  containersStopped: number;
  images: number;
  dockerVersion: string;
  operatingSystem: string;
  architecture: string;
  cpuCount: number;
  memoryTotalBytes: number;
}

export interface RoutingStatus {
  enabled: boolean;
  lastReconciledAt: string | null;
  lastReconcileSucceeded: boolean | null;
  lastError: string | null;
  routedAppCount: number;
}

export interface ContainerPort {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export interface ContainerSummary {
  id: string;
  shortId: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  created: number;
  ports: ContainerPort[];
  labels: Record<string, string>;
  isSystemContainer: boolean;
  isManagedApp: boolean;
}

export interface LogsResponse {
  containerId: string;
  logs: string;
}

export interface StoredApp {
  id: number;
  name: string;
  containerId: string | null;
  containerName: string | null;
  image: string;
  containerPort: number;
  domain: string | null;
  status: string;
  desiredStatus: string;
  restartPolicy: string;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt: string | null;
  routingReady: boolean;
  health: { state: HealthState; lastCheckedAt: string | null } | null;
  latestEventSeverity: DeploymentEventSeverity | null;
}

export interface StoredAppsResponse {
  apps: StoredApp[];
}

export interface AppDetail {
  id: number;
  name: string;
  status: string;
  desiredStatus: string;
  containerId: string | null;
  shortContainerId: string | null;
  containerName: string | null;
  image: string;
  containerPort: number;
  domain: string | null;
  routingReady: boolean;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt: string | null;
  restartPolicy: string;
  containerExists: boolean;
  dockerState: string | null;
  dockerStatusText: string | null;
  environmentStatus: EnvironmentStatus;
}

export type EnvironmentVariableSource = "global" | "app" | "app-override";
export type EnvironmentStatus = "applied" | "pending";

export interface MaskedGlobalEnvVar {
  id: number;
  key: string;
  isSecret: boolean;
  enabled: boolean;
  hasValue: boolean;
  value: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaskedAppEnvVar extends MaskedGlobalEnvVar {
  appId: number;
}

export interface EffectiveEnvVar {
  key: string;
  value: string | null;
  hasValue: boolean;
  isSecret: boolean;
  source: EnvironmentVariableSource;
}

export interface EffectiveEnvironmentResponse {
  variables: EffectiveEnvVar[];
  status: EnvironmentStatus;
}

export interface EnvVarFormValues {
  key: string;
  value: string;
  isSecret: boolean;
  enabled: boolean;
}

export interface ApiError {
  message?: string;
}

export interface CreateAppResponse {
  success: boolean;
  message: string;
  app?: {
    id: string;
    shortId: string;
    name: string;
    containerName: string;
    image: string;
    containerPort: number;
    domain: string;
    routingReady: boolean;
    state: string;
  };
}

export interface RedeployResponse {
  success: boolean;
  message: string;
  containerId?: string;
}

export interface StoredAppVolume {
  id: number;
  appId: number;
  volumeName: string;
  containerPath: string;
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StorageFormValues {
  containerPath: string;
  /** Empty string means "let the platform generate one". */
  volumeName: string;
  readOnly: boolean;
}

export type ContainerAction = "start" | "stop" | "restart";

export type RestartPolicy = "unless-stopped" | "always" | "on-failure" | "no";

export type BuildBriefRuntime =
  | "nodejs"
  | "python"
  | "php"
  | "static"
  | "docker"
  | "other";

export interface WizardEnvVarInput {
  key: string;
  value: string;
  isSecret: boolean;
  enabled: boolean;
}

export interface WizardVolumeInput {
  containerPath: string;
  /** Empty string means "let the platform generate one". */
  volumeName: string;
  readOnly: boolean;
}

export interface CreateAppWizardPayload {
  name: string;
  image: string;
  containerPort: number;
  restartPolicy: RestartPolicy;
  environmentVariables: Array<{
    key: string;
    value: string;
    isSecret: boolean;
    enabled: boolean;
  }>;
  storageMounts: Array<{
    containerPath: string;
    volumeName?: string;
    readOnly: boolean;
  }>;
}

export interface CreatedAppSummary {
  id: number;
  name: string;
  containerName: string;
  image: string;
  containerPort: number;
  domain: string | null;
  containerId: string | null;
  status: string;
  routingReady: boolean;
  environmentVariableCount: number;
  secretVariableCount: number;
  storageMountCount: number;
}

export interface CreateAppWizardResponse {
  success: boolean;
  message: string;
  app?: CreatedAppSummary;
}

export interface BuildBriefRequestPayload {
  appName: string;
  image?: string;
  containerPort: number;
  runtime: BuildBriefRuntime;
  description?: string;
  startCommand?: string;
  healthCheckPath?: string;
  environmentVariables: Array<{ key: string; isSecret: boolean }>;
  storageMounts: Array<{ containerPath: string; readOnly: boolean }>;
}

export interface BuildBriefResponse {
  success: boolean;
  domain: string;
  brief: string;
}

export type HealthState =
  | "disabled"
  | "unknown"
  | "healthy"
  | "unhealthy"
  | "checking"
  | "container-not-running"
  | "error";

export interface HealthCheckInfo {
  appId: number;
  configured: boolean;
  enabled: boolean;
  path: string;
  expectedStatus: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold: number;
  state: HealthState;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface HealthCheckFormValues {
  enabled: boolean;
  path: string;
  expectedStatus: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold: number;
}

export interface HealthCheckResponse {
  success: boolean;
  health: HealthCheckInfo;
}

export interface HealthCheckOutcome {
  appId: number;
  skipped: boolean;
  reason?: string;
  state?: HealthState;
  changed: boolean;
  /** False for a manual check run against a disabled configuration — the
   * probe ran for real, but nothing was saved and persistent state stays
   * "disabled". */
  persisted: boolean;
  statusCode?: number | null;
  latencyMs?: number | null;
  errorMessage?: string | null;
}

export interface RunHealthCheckResponse {
  success: boolean;
  outcome?: HealthCheckOutcome;
  health?: HealthCheckInfo;
  message?: string;
}

export interface ContainerMetrics {
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  pids: number | null;
}

export interface MetricsResponse {
  success: boolean;
  containerRunning: boolean;
  metrics: ContainerMetrics | null;
  message?: string;
}

export interface AppLogsResponse {
  success: boolean;
  appId: number;
  containerId: string | null;
  retrievedAt: string;
  lines: string[];
  truncated: boolean;
  containerRunning: boolean;
  error?: string;
}

export type DeploymentEventSeverity = "info" | "warning" | "error";

export interface DeploymentEvent {
  id: number;
  appId: number;
  eventType: string;
  severity: DeploymentEventSeverity;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface DeploymentEventsResponse {
  success: boolean;
  events: DeploymentEvent[];
  hasMore: boolean;
}
