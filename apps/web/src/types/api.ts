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
  /** True only after a real reconciliation validated, applied, and verified. */
  active: boolean;
  lastReconciledAt: string | null;
  lastReconcileSucceeded: boolean | null;
  lastError: string | null;
  routedAppCount: number;
  rejectedRouteCount: number;
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
  internalOnly: boolean;
  status: string;
  desiredStatus: string;
  restartPolicy: string;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt: string | null;
  routingReady: boolean;
  health: { state: HealthState; lastCheckedAt: string | null } | null;
  latestEventSeverity: DeploymentEventSeverity | null;
  /**
   * Live Docker runtime state for this app, cross-checked against the actual
   * container. `present: false` means the database record exists but the
   * container is gone (recovery required). `null` means Docker could not be
   * queried, so `status` should be trusted as the best available signal.
   */
  runtime?: { present: boolean; running: boolean; status: string | null } | null;
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
  internalOnly: boolean;
  routingReady: boolean;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt: string | null;
  restartPolicy: string;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
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
    domain: string | null;
    internalOnly: boolean;
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
  memoryLimitMb?: number | null;
  cpuLimit?: number | null;
  internalOnly: boolean;
  customDomain?: string;
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
  internalOnly: boolean;
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
  internalOnly: boolean;
  customDomain?: string;
  runtime: BuildBriefRuntime;
  description?: string;
  startCommand?: string;
  healthCheckPath?: string;
  environmentVariables: Array<{ key: string; isSecret: boolean }>;
  storageMounts: Array<{ containerPath: string; readOnly: boolean }>;
}

export interface BuildBriefResponse {
  success: boolean;
  domain: string | null;
  brief: string;
}

export interface UpdateAppRoutingPayload {
  internalOnly: boolean;
  customDomain?: string;
}

export interface UpdateAppRoutingResponse {
  success: boolean;
  message: string;
  domain?: string | null;
  internalOnly?: boolean;
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

// ---------- Deployment history / version ledger ----------

export type DeploymentSourceKind = "github" | "image";

export interface Deployment {
  id: number;
  appId: number;
  version: number;
  imageTag: string;
  commitSha: string | null;
  commitMessage: string | null;
  sourceKind: DeploymentSourceKind;
  revertOfVersion: number | null;
  isCurrent: boolean;
  /** Server-computed: a retained GitHub build that isn't already live. */
  canRevert: boolean;
  createdAt: string;
}

export interface DeploymentsResponse {
  success: boolean;
  deployments: Deployment[];
}

export interface RevertResponse {
  success: boolean;
  message: string;
  newVersion?: number;
}

// ---------- Build logs / auto-deploy ----------

export type BuildStatus = "success" | "failed" | "reused";

export interface BuildLog {
  log: string | null;
  truncated: boolean;
  status: BuildStatus | string | null;
  at: string | null;
}

export interface BuildLogResponse {
  success: boolean;
  /** null when the app has no linked source (e.g. a plain image app). */
  buildLog: BuildLog | null;
}

export interface AutoDeployResponse {
  success: boolean;
  autoDeploy: boolean;
}

export interface SuggestPortResponse {
  success: boolean;
  port: number;
}

export interface ImagePruneInfo {
  success: boolean;
  keepPerApp: number;
  candidates: number;
  reclaimableBytes: number;
}

export interface ImagePruneResult {
  success: boolean;
  removed: number;
  reclaimedBytes: number;
  failed: number;
}

export interface AutoBackupConfig {
  enabled: boolean;
  intervalHours: number;
  retention: number;
}

export interface AutoBackupFileInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AutoBackupResponse {
  success: boolean;
  config: AutoBackupConfig;
  lastRunAt: number | null;
  backups: AutoBackupFileInfo[];
}

export type NotificationType = "discord" | "slack" | "generic";

export interface NotificationConfig {
  enabled: boolean;
  type: NotificationType;
  webhookUrl: string;
}

export interface NotificationResponse {
  success: boolean;
  config: NotificationConfig;
}

// ---------- GitHub integration (Phase 10) ----------

export type SourceProviderName = "github";

export type CredentialStatus =
  | "not-configured"
  | "connected"
  | "encryption-key-missing"
  | "encryption-key-invalid"
  | "credential-unavailable";

export interface GithubConnectionInfo {
  success: boolean;
  connected: boolean;
  provider: SourceProviderName;
  username: string | null;
  lastValidatedAt: string | null;
  credentialStatus: CredentialStatus;
  permissions: string[] | null;
  setupRequired: boolean;
  message?: string;
}

export interface SourceAccount {
  username: string;
  htmlUrl: string;
}

export interface TestGithubTokenResponse {
  success: boolean;
  account?: SourceAccount;
  message?: string;
}

export interface SourceRepository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  description: string | null;
  defaultBranch: string;
  htmlUrl: string;
  pushedAt: string | null;
  updatedAt: string | null;
}

export interface GithubRepositoriesResponse {
  success: boolean;
  repositories: SourceRepository[];
  hasMore: boolean;
  message?: string;
  credentialStatus?: CredentialStatus;
  /** Which credential the list came from — "installation" (GitHub App) or "pat" (advanced fallback). */
  source?: "installation" | "pat";
}

export interface GithubAppInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  targetType: string;
  repositorySelection: string;
  createdAt: string;
  updatedAt: string;
}

export interface GithubAppInstallationsResponse {
  success: boolean;
  configured: boolean;
  missing?: string[];
  installations: GithubAppInstallation[];
  message?: string;
}

export interface GithubRepositoryResponse {
  success: boolean;
  repository?: SourceRepository;
  message?: string;
}

export interface SourceBranch {
  name: string;
  commitSha: string;
  protected: boolean;
}

export interface GithubBranchesResponse {
  success: boolean;
  branches: SourceBranch[];
  hasMore: boolean;
  message?: string;
}

export interface SourceCommit {
  sha: string;
  message: string;
  authorName: string | null;
  authorDate: string | null;
  htmlUrl: string;
}

export interface GithubCommitsResponse {
  success: boolean;
  commits: SourceCommit[];
  hasMore: boolean;
  message?: string;
}

export type DeploymentMode = "prebuilt-image" | "dockerfile";
export type SourceValidationStatus = "unknown" | "valid" | "invalid";

// ---------- GitHub deployment (Phase 11) ----------

export type BuildStrategy = "dockerfile" | "nodejs" | "static" | "unsupported";

export type DetectedProjectType =
  | "dockerfile"
  | "nodejs"
  | "static"
  | "docker-compose"
  | "python"
  | "go"
  | "rust"
  | "php"
  | "ruby"
  | "java"
  | "unknown";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageJsonSummary {
  packageManager: PackageManager;
  hasBuildScript: boolean;
  hasStartScript: boolean;
}

export type PortDetectionSource =
  | "dockerfile-expose"
  | "dockerfile-env"
  | "package-script"
  | "source-code"
  | "framework-default"
  | "platform-default"
  | "none";

export type PortDetectionConfidence = "high" | "medium" | "low" | "none";

export interface PortDetectionResult {
  detectedPort: number | null;
  source: PortDetectionSource;
  confidence: PortDetectionConfidence;
  evidence: string[];
  warnings: string[];
}

export interface RepositoryInspectionResult {
  detectedProjectType: DetectedProjectType;
  recommendedStrategy: BuildStrategy;
  presentFiles: string[];
  packageJson: PackageJsonSummary | null;
  warnings: string[];
  supported: boolean;
  unsupportedReason: string | null;
  portDetection: PortDetectionResult;
}

export interface InspectSourceResponse {
  success: boolean;
  commitSha?: string;
  inspection?: RepositoryInspectionResult;
  message?: string;
}

export interface GithubDeployResponse {
  success: boolean;
  message: string;
  stage?: string;
  rolledBack?: boolean;
  containerId?: string;
  imageTag?: string;
  commitSha?: string;
}

export interface GithubDeployStatusResponse {
  success: boolean;
  inProgress: boolean;
  message?: string;
}

export interface AppSourceInfo {
  appId: number;
  provider: SourceProviderName;
  repositoryOwner: string;
  repositoryName: string;
  repositoryFullName: string | null;
  repositoryId: string | null;
  repositoryVisibility: "public" | "private" | null;
  branch: string;
  subdirectory: string;
  deploymentMode: DeploymentMode;
  dockerfilePath: string;
  buildContext: string;
  buildStrategy: BuildStrategy | null;
  /** The operator's own explicit strategy choice — null means "follow the inspection recommendation automatically." Never overwritten by an inspection rerun. */
  selectedStrategy: Exclude<BuildStrategy, "unsupported"> | null;
  detectedProjectType: DetectedProjectType | null;
  containerPort: number | null;
  containerPortSource: string | null;
  containerPortConfidence: string | null;
  autoDeploy: boolean;
  lastValidatedCommitSha: string | null;
  lastValidatedAt: string | null;
  validationStatus: SourceValidationStatus;
  validationError: string | null;
  latestRemoteCommitSha: string | null;
  latestDeployedCommitSha: string | null;
  latestDeployedCommitMessage: string | null;
  latestDeployedAt: string | null;
  lastInternalHealthResult: string | null;
  lastPublicHealthResult: string | null;
  lastDeploymentStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppSourceResponse {
  success: boolean;
  source: AppSourceInfo | null;
  message?: string;
}

export interface AppSourceConfigFormValues {
  repositoryOwner: string;
  repositoryName: string;
  branch: string;
  subdirectory: string;
  deploymentMode: DeploymentMode;
  dockerfilePath: string;
  buildContext: string;
  containerPort: number | null;
  containerPortSource: string | null;
  containerPortConfidence: string | null;
  autoDeploy: boolean;
}

// ---------- Performance Diagnostics ----------

export interface PublicProbeResult {
  ok: boolean;
  totalMs: number | null;
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  statusCode: number | null;
  responseBytes: number | null;
  redirectCount: number;
  finalHost: string | null;
  error: string | null;
}

export interface InternalProbeResult {
  ok: boolean;
  totalMs: number | null;
  connectMs: number | null;
  ttfbMs: number | null;
  statusCode: number | null;
  responseBytes: number | null;
  error: string | null;
  port: number | null;
}

export type ResourceCategory = "javascript" | "css" | "image" | "font" | "api" | "other";

export interface ResourceCategorySummary {
  category: ResourceCategory;
  count: number;
  totalTransferBytes: number;
  totalDurationMs: number;
  slowestPath: string | null;
  slowestDurationMs: number;
  failedCount: number;
}

export interface SanitizedResourceEntry {
  category: ResourceCategory;
  host: string;
  path: string;
  firstParty: boolean;
  startMs: number;
  durationMs: number;
  transferBytes: number | null;
  statusOk: boolean;
}

export interface PerformanceDiagnosticBrowserSummary {
  submittedAt: string | null;
  available: boolean;
  dnsMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  pageLoadMs: number | null;
  totalNavigationMs: number | null;
  transferBytes: number | null;
}

export interface PerformanceDiagnostic {
  id: number;
  appId: number;
  createdAt: string;
  publicProbe: PublicProbeResult;
  internalProbe: InternalProbeResult;
  browser: PerformanceDiagnosticBrowserSummary;
  resourceSummary: ResourceCategorySummary[] | null;
  topResources: SanitizedResourceEntry[] | null;
  diagnosis: {
    category: string | null;
    message: string | null;
    evidence: string[];
  };
}

export interface PerformanceDiagnosticResponse {
  success: boolean;
  diagnostic: PerformanceDiagnostic | null;
  message?: string;
}

export interface PerformanceDiagnosticHistoryResponse {
  success: boolean;
  history: PerformanceDiagnostic[];
  message?: string;
}

export interface BrowserNavigationTimingPayload {
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  requestStartMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  domInteractiveMs: number | null;
  domContentLoadedMs: number | null;
  pageLoadMs: number | null;
  totalNavigationMs: number | null;
  transferBytes: number | null;
  encodedBodyBytes: number | null;
  decodedBodyBytes: number | null;
  available: boolean;
}

export interface BrowserResourceEntryPayload {
  url: string;
  initiatorType: string;
  startMs: number;
  durationMs: number;
  transferBytes: number | null;
  statusOk: boolean;
}
