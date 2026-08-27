import type {
  StoredAppEnvVar,
  StoredGlobalEnvVar
} from "../environment-database.js";

export type EnvironmentVariableSource = "global" | "app" | "app-override";

export interface EffectiveEnvVar {
  key: string;
  value: string | null;
  hasValue: boolean;
  isSecret: boolean;
  source: EnvironmentVariableSource;
}

export type EnvironmentStatus = "applied" | "pending";

/**
 * Effective environment for a container: enabled global variables, then
 * enabled app variables layered on top (app wins on key collision). Secret
 * values are masked here since this is what API responses return — the
 * real values are only read directly from the repository, server-side,
 * when actually building a container's Env array.
 */
export function buildEffectiveEnvironment(
  globalVars: StoredGlobalEnvVar[],
  appVars: StoredAppEnvVar[]
): EffectiveEnvVar[] {
  const merged = new Map<string, EffectiveEnvVar>();

  for (const globalVar of globalVars) {
    if (!globalVar.enabled) {
      continue;
    }

    merged.set(globalVar.key, {
      key: globalVar.key,
      value: globalVar.isSecret ? null : globalVar.value,
      hasValue: globalVar.value.length > 0,
      isSecret: globalVar.isSecret,
      source: "global"
    });
  }

  for (const appVar of appVars) {
    if (!appVar.enabled) {
      continue;
    }

    const overridesGlobal = merged.has(appVar.key);

    merged.set(appVar.key, {
      key: appVar.key,
      value: appVar.isSecret ? null : appVar.value,
      hasValue: appVar.value.length > 0,
      isSecret: appVar.isSecret,
      source: overridesGlobal ? "app-override" : "app"
    });
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.key.localeCompare(b.key)
  );
}

/**
 * Real, unmasked KEY=value pairs for Docker's Env array. Only ever used
 * server-side when creating/recreating a container — never returned over
 * HTTP.
 */
export function buildContainerEnvArray(
  globalVars: StoredGlobalEnvVar[],
  appVars: StoredAppEnvVar[]
): string[] {
  const merged = new Map<string, string>();

  for (const globalVar of globalVars) {
    if (globalVar.enabled) {
      merged.set(globalVar.key, globalVar.value);
    }
  }

  for (const appVar of appVars) {
    if (appVar.enabled) {
      merged.set(appVar.key, appVar.value);
    }
  }

  return Array.from(merged.entries()).map(([key, value]) => `${key}=${value}`);
}

function formatExportValue(value: string): string {
  return /^[A-Za-z0-9_./:@%+,-]*$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Password-gated .env-style export. This is only returned by the dedicated
 * export routes; ordinary environment responses remain masked.
 */
export function buildEnvironmentExport(
  globalVars: StoredGlobalEnvVar[],
  appVars: StoredAppEnvVar[] = []
): string {
  const merged = new Map<string, string>();

  for (const variable of globalVars) {
    if (variable.enabled) merged.set(variable.key, variable.value);
  }
  for (const variable of appVars) {
    if (variable.enabled) merged.set(variable.key, variable.value);
  }

  return Array.from(merged.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${formatExportValue(value)}`)
    .join("\n");
}

/**
 * Docker can't update a running container's environment in place. An app's
 * environment is "pending" whenever something relevant changed more
 * recently than the app's last deployment — global variable changes touch
 * every app, app-variable changes touch just that app (see
 * touchAppEnvironment / touchAllAppsEnvironment in database.ts).
 */
export function computeEnvironmentStatus(
  lastDeployedAt: string | null,
  environmentTouchedAt: string | null
): EnvironmentStatus {
  if (!environmentTouchedAt) {
    return "applied";
  }

  if (!lastDeployedAt) {
    return "pending";
  }

  return new Date(environmentTouchedAt).getTime() >
    new Date(lastDeployedAt).getTime()
    ? "pending"
    : "applied";
}
