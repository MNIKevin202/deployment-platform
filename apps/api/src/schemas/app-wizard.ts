import { z } from "zod";
import {
  appNameSchema,
  containerPortSchema,
  imageSchema,
  restartPolicySchema
} from "./app.js";
import { envKeySchema, envValueSchema } from "./environment.js";
import { containerPathSchema, volumeNameSchema } from "./storage.js";

const MAX_WIZARD_ENV_VARS = 100;
const MAX_WIZARD_VOLUMES = 25;

export const wizardEnvVarSchema = z.object({
  key: envKeySchema,
  value: envValueSchema,
  isSecret: z.boolean().optional().default(false),
  enabled: z.boolean().optional().default(true)
});

export const wizardVolumeSchema = z.object({
  containerPath: containerPathSchema,
  volumeName: volumeNameSchema.optional(),
  readOnly: z.boolean().optional().default(false)
});

/**
 * The full wizard creation payload. Duplicate keys/paths/names are
 * rejected here, before anything touches the database or Docker — the
 * same shape a caller building their own client against this API would
 * need to satisfy, so there is no separate/looser contract for the UI.
 */
export const createAppWizardSchema = z.object({
  name: appNameSchema,
  image: imageSchema,
  containerPort: containerPortSchema,
  restartPolicy: restartPolicySchema.optional().default("unless-stopped"),
  environmentVariables: z
    .array(wizardEnvVarSchema)
    .max(MAX_WIZARD_ENV_VARS)
    .optional()
    .default([])
    .refine(
      (vars) => new Set(vars.map((v) => v.key)).size === vars.length,
      "Duplicate environment variable keys are not allowed"
    ),
  storageMounts: z
    .array(wizardVolumeSchema)
    .max(MAX_WIZARD_VOLUMES)
    .optional()
    .default([])
    .refine(
      (mounts) =>
        new Set(mounts.map((m) => m.containerPath)).size === mounts.length,
      "Duplicate container paths are not allowed"
    )
    .refine((mounts) => {
      const namedVolumes = mounts
        .map((m) => m.volumeName)
        .filter((name): name is string => Boolean(name));
      return new Set(namedVolumes).size === namedVolumes.length;
    }, "Duplicate volume names are not allowed")
});

export type CreateAppWizardInput = z.infer<typeof createAppWizardSchema>;

/**
 * Request body for the deterministic build-brief generator. Only
 * environment variable keys and secret flags are accepted — never
 * values — so there is no code path through which a value, secret or
 * not, could end up in the generated brief.
 */
export const buildBriefRequestSchema = z.object({
  appName: appNameSchema,
  image: imageSchema.optional().default(""),
  containerPort: containerPortSchema,
  runtime: z.enum([
    "nodejs",
    "python",
    "php",
    "static",
    "docker",
    "other"
  ]),
  description: z.string().max(2000).optional(),
  startCommand: z.string().max(500).optional(),
  healthCheckPath: z.string().max(255).optional(),
  environmentVariables: z
    .array(
      z.object({
        key: envKeySchema,
        isSecret: z.boolean().optional().default(false)
      })
    )
    .max(MAX_WIZARD_ENV_VARS)
    .optional()
    .default([]),
  storageMounts: z
    .array(
      z.object({
        containerPath: containerPathSchema,
        readOnly: z.boolean().optional().default(false)
      })
    )
    .max(MAX_WIZARD_VOLUMES)
    .optional()
    .default([])
});

export type BuildBriefRequestInput = z.infer<typeof buildBriefRequestSchema>;
