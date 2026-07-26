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

export type ContainerAction = "start" | "stop" | "restart";
