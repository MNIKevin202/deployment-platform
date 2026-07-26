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

/** The original, minimal creation payload — unchanged for backward compatibility. */
export const createAppSchema = z.object({
  name: appNameSchema,
  image: imageSchema,
  containerPort: containerPortSchema
});
