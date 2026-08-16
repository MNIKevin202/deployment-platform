import { z } from "zod";
import { envKeySchema } from "./environment.js";

export const CONNECTION_KINDS = [
  "mongodb",
  "postgres",
  "mysql",
  "redis",
  "sqlite",
  "other"
] as const;

const MAX_NAME_LENGTH = 200;
const MAX_CONNECTION_STRING_LENGTH = 4096;

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(MAX_NAME_LENGTH, "Name is too long");

const kindSchema = z.enum(CONNECTION_KINDS);

const connectionStringSchema = z
  .string()
  .min(1, "Connection string is required")
  .max(MAX_CONNECTION_STRING_LENGTH, "Connection string is too large")
  .refine(
    (value) => !value.includes("\0"),
    "Connection string must not contain null bytes"
  );

// A blank env key means "copy-only, don't expose as a variable". Anything
// non-blank must be a valid environment variable name.
const envKeyFieldSchema = z
  .union([z.literal(""), envKeySchema])
  .transform((value) => (value === "" ? null : value))
  .nullable();

export const createConnectionSchema = z.object({
  name: nameSchema,
  kind: kindSchema,
  connectionString: connectionStringSchema,
  envKey: envKeyFieldSchema.optional().default(null)
});

export const updateConnectionSchema = z
  .object({
    name: nameSchema.optional(),
    kind: kindSchema.optional(),
    // On an edit, an omitted connection string keeps the stored one — this is
    // how the UI lets you rename/re-key a connection without re-entering the
    // secret.
    connectionString: connectionStringSchema.optional(),
    envKey: envKeyFieldSchema.optional()
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.kind !== undefined ||
      data.connectionString !== undefined ||
      data.envKey !== undefined,
    "At least one field must be provided"
  );
