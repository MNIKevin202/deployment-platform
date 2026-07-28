// The apps base domain is chosen by the operator at install time (the
// installer's --apps-domain / "Apps base domain" prompt) and passed to the API
// as APPS_DOMAIN — see installer/templates/platform.env.template, which renders
// APPS_DOMAIN=<value> into config/platform.env.
//
// This module historically read APPS_DOMAIN_ROOT, a name the installer never
// sets, so it silently fell back to a hardcoded developer domain
// ("apps.hookstats.com") and generated every app's domain under the wrong
// base — even when the operator had correctly configured apps.devminted.com.
// Read APPS_DOMAIN first (the supported configuration source), accept
// APPS_DOMAIN_ROOT as a legacy alias, and use an obviously-non-production
// fallback only for local development and tests (a real deployment always
// provides APPS_DOMAIN).
const FALLBACK_APPS_DOMAIN = "apps.localhost";

/** Resolves the apps base domain from the environment, in precedence order. */
export function resolveAppsDomainRoot(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.APPS_DOMAIN ?? env.APPS_DOMAIN_ROOT ?? FALLBACK_APPS_DOMAIN;
}

export const appsDomainRoot = resolveAppsDomainRoot();

/**
 * App names are already validated against /^[a-z0-9]+(?:-[a-z0-9]+)*$/
 * before this is called, so the result is always a safe DNS label.
 */
export function buildAppDomain(appName: string): string {
  return `${appName}.${appsDomainRoot}`;
}
