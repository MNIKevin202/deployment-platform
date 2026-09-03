import { z } from "zod";

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_KEY_LENGTH = 256;
const MAX_ENV_VALUE_LENGTH = 4096;

export const envKeySchema = z
  .string()
  .min(1, "Key is required")
  .max(MAX_ENV_KEY_LENGTH)
  .regex(
    ENV_KEY_PATTERN,
    "Key must start with a letter or underscore and contain only letters, numbers, and underscores"
  );

export const envValueSchema = z
  .string()
  .max(MAX_ENV_VALUE_LENGTH, "Value is too large")
  .refine((value) => !value.includes("\0"), "Value must not contain null bytes");

export const createEnvVarSchema = z.object({
  key: envKeySchema,
  value: envValueSchema,
  isSecret: z.boolean().optional().default(false),
  enabled: z.boolean().optional().default(true)
});

export const updateEnvVarSchema = z
  .object({
    value: envValueSchema.optional(),
    isSecret: z.boolean().optional(),
    enabled: z.boolean().optional()
  })
  .refine(
    (data) => data.value !== undefined || data.isSecret !== undefined || data.enabled !== undefined,
    "At least one field must be provided"
  );

export const moveEnvVarSchema = z.object({
  direction: z.enum(["global-to-app", "app-to-global"]),
  key: envKeySchema,
  // What to do with the variable in the location it moved OUT of.
  disposition: z.enum(["disable", "delete"])
});

const MAX_BULK_VARS = 200;

export const bulkEnvVarsSchema = z.object({
  variables: z
    .array(
      z.object({
        key: envKeySchema,
        value: envValueSchema,
        // Omitted means "leave as-is" on an update, or "not secret" on create —
        // see the route handler for exactly how each case is resolved.
        isSecret: z.boolean().optional()
      })
    )
    .min(1, "At least one variable is required")
    .max(MAX_BULK_VARS, `A single bulk update is limited to ${MAX_BULK_VARS} variables`)
});
