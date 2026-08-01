import { z } from "zod";
import { parseCronExpression } from "../services/cron-expression.js";

const cronExpressionSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => parseCronExpression(value).ok, {
    message: "Not a valid 5-field cron expression"
  });

const commandSchema = z.string().min(1, "A command is required").max(4000);
const nameSchema = z.string().min(1, "A name is required").max(120);
// Bounded so a single scheduled command can't hold a container's exec slot
// indefinitely; 1 hour is a generous ceiling for a maintenance task.
const timeoutSchema = z.number().int().min(1).max(3600).optional().default(300);

export const createCronJobSchema = z.object({
  appId: z.number().int().positive(),
  name: nameSchema,
  cronExpression: cronExpressionSchema,
  command: commandSchema,
  enabled: z.boolean().optional().default(true),
  timeoutSeconds: timeoutSchema
});

export const updateCronJobSchema = z.object({
  name: nameSchema,
  cronExpression: cronExpressionSchema,
  command: commandSchema,
  enabled: z.boolean(),
  timeoutSeconds: timeoutSchema
});

export const previewCronSchema = z.object({
  cronExpression: z.string().min(1).max(120)
});

export type CreateCronJobInput = z.infer<typeof createCronJobSchema>;
export type UpdateCronJobInput = z.infer<typeof updateCronJobSchema>;
