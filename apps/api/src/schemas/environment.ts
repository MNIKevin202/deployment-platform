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
