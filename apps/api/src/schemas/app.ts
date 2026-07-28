import { z } from "zod";

export const APP_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const appNameSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(
    APP_NAME_PATTERN,
    "Name must contain lowercase letters, numbers, and hyphens only"
  );

export const imageSchema = z.string().min(1).max(200);

export const containerPortSchema = z.number().int().min(1).max(65535);

export const RESTART_POLICIES = [
  "unless-stopped",
  "always",
  "on-failure",
  "no"
] as const;

export const restartPolicySchema = z.enum(RESTART_POLICIES);

/**
 * A custom domain field, as raw operator input — length-bounded here only
 * to reject absurd payloads early; the real normalization/validation
 * (lowercasing, trailing-dot handling, scheme/path/port/wildcard/localhost/
 * IP rejection, SAFE_DOMAIN) lives in domain.ts's validateCustomDomain, the
 * single source of truth both app creation and the routing-update route
 * call through resolveAppDomainChoice.
 */
export const customDomainSchema = z.string().min(1).max(253);

/**
 * The original, minimal creation payload — unchanged for backward
 * compatibility for callers that send neither field (internalOnly defaults
 * false, customDomain absent -> the generated default domain, exactly as
 * before `internalOnly`/`customDomain` existed).
 */
export const createAppSchema = z.object({
  name: appNameSchema,
  image: imageSchema,
  containerPort: containerPortSchema,
  internalOnly: z.boolean().optional().default(false),
  customDomain: customDomainSchema.optional()
});

/**
 * Shared routing-choice fields: opt into internal-only (no public
 * domain/route) or, for a public app, an optional custom domain instead of
 * the generated default. Both optional and independently defaulted so
 * existing callers that send neither keep today's behavior (a public app
 * with the generated domain) — see resolveAppDomainChoice in domain.ts for
 * the exact resolution rules and the internalOnly+customDomain rejection.
 */
export const appRoutingChoiceSchema = z.object({
  internalOnly: z.boolean().optional().default(false),
  customDomain: customDomainSchema.optional()
});

/** PATCH /apps/:id/routing — toggle public/internal-only and/or change the domain. */
export const updateAppRoutingSchema = appRoutingChoiceSchema;
