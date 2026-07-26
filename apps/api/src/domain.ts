const DEFAULT_APPS_DOMAIN_ROOT = "apps.hookstats.com";

export const appsDomainRoot =
  process.env.APPS_DOMAIN_ROOT ?? DEFAULT_APPS_DOMAIN_ROOT;

/**
 * App names are already validated against /^[a-z0-9]+(?:-[a-z0-9]+)*$/
 * before this is called, so the result is always a safe DNS label.
 */
export function buildAppDomain(appName: string): string {
  return `${appName}.${appsDomainRoot}`;
}
