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

// ============================================================
// Custom domains
// ============================================================
//
// A managed app's domain is either the generated default
// (`${appName}.${APPS_DOMAIN}`, above) or an operator-supplied custom
// domain such as `roadmapstudio.xyz` — e.g. for a web app that needs its
// own apex domain rather than a subdomain of the platform's shared base.
// Both are stored in the same `apps.domain` column and routed through the
// same Caddy-generation path (routing-service.ts's `buildRoutes`), so a
// custom domain is validated at least as strictly as a generated one:
// this module's `SAFE_DOMAIN` is the single source of truth both use.
//
// DNS ownership is NOT verified here (or anywhere in the platform): for
// this private, single-operator milestone, pointing a custom domain's DNS
// A/AAAA record at the VPS is the operator's own responsibility, done
// outside the platform, before (or after) the app is created. Caddy's
// on-demand-free static-domain routing will only actually serve/obtain a
// certificate for a domain once DNS resolves to this host.

/**
 * A full hostname: one or more DNS labels joined by dots, lowercase, total
 * length <= 253, each label 1–63 chars, no leading/trailing hyphen. This
 * excludes whitespace, `{`, `}`, `#`, and every other character a Caddy
 * directive could hide behind — so a domain value can never break out of
 * its site-address position and inject a directive. Requires at least two
 * labels (rejects a single bare label with no dot).
 */
export const SAFE_DOMAIN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/; // control characters only, deliberately narrow
const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export type DomainValidationResult =
  | { ok: true; domain: string }
  | { ok: false; error: string };

/**
 * Normalizes and validates an operator-supplied custom domain. Never
 * throws — every rejection comes back as `{ ok: false, error }` with a
 * message safe to return directly in a 400 response.
 */
export function validateCustomDomain(raw: unknown): DomainValidationResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "Custom domain is required" };
  }

  if (CONTROL_CHAR_PATTERN.test(raw)) {
    return { ok: false, error: "Domain must not contain control characters" };
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: "Custom domain is required" };
  }

  if (/\s/.test(trimmed)) {
    return { ok: false, error: "Domain must not contain spaces" };
  }

  let value = trimmed.toLowerCase();

  if (value.includes("://")) {
    return { ok: false, error: "Domain must not include a scheme (e.g. https://)" };
  }
  if (value.includes("@")) {
    return { ok: false, error: "Domain must not include credentials" };
  }
  if (value.includes("/")) {
    return { ok: false, error: "Domain must not include a path" };
  }
  if (value.includes("?")) {
    return { ok: false, error: "Domain must not include a query string" };
  }
  if (value.includes("#")) {
    return { ok: false, error: "Domain must not include a fragment" };
  }
  if (value.includes("*")) {
    return { ok: false, error: "Domain must not include a wildcard" };
  }
  if (value.includes(":")) {
    return { ok: false, error: "Domain must not include a port" };
  }

  // A single accidental trailing dot (FQDN notation) is normalized away;
  // anything else wrong with the edges is rejected rather than guessed at.
  if (value.endsWith("..") || value.startsWith(".")) {
    return { ok: false, error: "Domain is malformed" };
  }
  if (value.endsWith(".")) {
    value = value.slice(0, -1);
  }

  if (value.length === 0 || value.length > 253) {
    return { ok: false, error: "Domain length is invalid" };
  }

  if (value === "localhost" || value.endsWith(".localhost")) {
    return { ok: false, error: "localhost is not allowed as a public domain" };
  }

  if (IPV4_PATTERN.test(value)) {
    return { ok: false, error: "An IP address is not allowed as a domain" };
  }

  if (!SAFE_DOMAIN.test(value)) {
    return {
      ok: false,
      error: "Domain must be a valid hostname with at least two labels"
    };
  }

  return { ok: true, domain: value };
}

/**
 * True if `domain` falls inside the platform's generated-domain namespace
 * (equal to, or a subdomain of, APPS_DOMAIN) — reserved for
 * `buildAppDomain()` output, never assignable as a custom domain. Without
 * this, an operator could claim `some-future-app.apps.devminted.com` as a
 * "custom" domain today and permanently block that app name from ever
 * getting its normal generated domain later.
 */
export function isGeneratedDomainNamespace(
  domain: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const root = resolveAppsDomainRoot(env).toLowerCase();
  const value = domain.toLowerCase();
  return value === root || value.endsWith(`.${root}`);
}

export interface AppDomainChoiceInput {
  internalOnly: boolean;
  /** Present only for a public app that wants a custom domain instead of the generated default. */
  customDomain?: string | null;
}

export type AppDomainChoiceResult =
  | { ok: true; domain: string | null; internalOnly: boolean }
  | { ok: false; statusCode: 400; error: string };

/**
 * Resolves the create/update-time domain policy shared by app creation and
 * the domain/internal-only update route:
 *
 *   internalOnly=true  + customDomain present -> rejected (mutually exclusive)
 *   internalOnly=true  + no customDomain       -> domain = null
 *   internalOnly=false + no customDomain       -> domain = generated default
 *   internalOnly=false + customDomain present  -> domain = validated custom domain
 *
 * Does not check cross-app uniqueness (a database concern — see
 * `getAppByDomain` in database.ts) or Docker/Caddy state; this is pure
 * input-shape policy, so it is unit-testable without either.
 */
export function resolveAppDomainChoice(
  appName: string,
  input: AppDomainChoiceInput,
  env: NodeJS.ProcessEnv = process.env,
  buildDefaultDomain: (name: string) => string = buildAppDomain
): AppDomainChoiceResult {
  const hasCustomDomain =
    typeof input.customDomain === "string" && input.customDomain.trim().length > 0;

  if (input.internalOnly) {
    if (hasCustomDomain) {
      return {
        ok: false,
        statusCode: 400,
        error: "An internal-only app cannot also have a custom domain"
      };
    }
    return { ok: true, domain: null, internalOnly: true };
  }

  if (!hasCustomDomain) {
    return { ok: true, domain: buildDefaultDomain(appName), internalOnly: false };
  }

  const validated = validateCustomDomain(input.customDomain);
  if (!validated.ok) {
    return { ok: false, statusCode: 400, error: validated.error };
  }

  if (isGeneratedDomainNamespace(validated.domain, env)) {
    return {
      ok: false,
      statusCode: 400,
      error: `Custom domain must not be inside the platform's generated-domain namespace (${resolveAppsDomainRoot(env)})`
    };
  }

  return { ok: true, domain: validated.domain, internalOnly: false };
}

/**
 * Whether `backfillMissingAppDomains()` (server.ts, run once on every API
 * boot) should assign this app a generated default domain. True only for
 * the legacy case it exists to fix — a null domain on an app that predates
 * `internal_only` and was never explicitly marked internal. An
 * explicitly internal-only app's null domain is a deliberate, persisted
 * choice and must never be backfilled, no matter how many times the API
 * restarts.
 */
export function shouldBackfillAppDomain(app: {
  domain: string | null;
  internalOnly: boolean;
}): boolean {
  return app.domain === null && !app.internalOnly;
}
