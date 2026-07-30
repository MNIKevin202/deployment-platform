export interface AppResourceLimits {
  memoryLimitMb: number | null;
  cpuLimit: number | null;
}

export interface ResourceHostConfig {
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
}

/**
 * Translates an app's optional resource caps into the Docker HostConfig
 * fields that enforce them. A null/zero limit is omitted entirely, so an app
 * with no limits gets exactly the same HostConfig it always did.
 *
 * Memory is a hard cap: MemorySwap is pinned to the same value so the
 * container can't exceed the limit by swapping. CPU is expressed in cores
 * (fractions allowed) and mapped to NanoCpus.
 */
export function buildResourceHostConfig(app: AppResourceLimits): ResourceHostConfig {
  const config: ResourceHostConfig = {};

  if (app.memoryLimitMb && app.memoryLimitMb > 0) {
    config.Memory = Math.round(app.memoryLimitMb * 1024 * 1024);
    config.MemorySwap = config.Memory;
  }

  if (app.cpuLimit && app.cpuLimit > 0) {
    config.NanoCpus = Math.round(app.cpuLimit * 1_000_000_000);
  }

  return config;
}
