import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import type { CronDockerOps } from "../services/cron-executor-service.js";
import { runCronJob } from "../services/cron-executor-service.js";
import { previewCron } from "../services/cron-expression.js";
import {
  createCronJobSchema,
  previewCronSchema,
  updateCronJobSchema
} from "../schemas/cron.js";

interface RegisterCronRoutesOptions {
  appDatabase: AppDatabase;
  dockerOps: CronDockerOps;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function registerCronRoutes(
  app: FastifyInstance,
  { appDatabase, dockerOps }: RegisterCronRoutesOptions
): void {
  app.get("/cron-jobs", async () => {
    // Each job carries a plain-English rendering of its schedule, from the
    // same describer the create/edit form's live preview uses — so the list
    // can show "Every 15 minutes" beside the raw expression without the
    // panel needing a preview request per job.
    const jobs = appDatabase.listCronJobs().map((job) => {
      const preview = previewCron(job.cronExpression);
      return {
        ...job,
        scheduleDescription: preview.ok ? preview.description : null
      };
    });

    return { success: true, jobs };
  });

  // A job's run history, newest first — every scheduled fire and manual
  // "Run now", with its captured output.
  app.get("/cron-jobs/:id/runs", async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ success: false, message: "Invalid cron job id" });
    }

    const job = appDatabase.getCronJob(params.data.id);
    if (!job) {
      return reply.code(404).send({ success: false, message: "Cron job not found" });
    }

    return reply.send({ success: true, runs: appDatabase.listCronJobRuns(job.id) });
  });

  // A live plain-English preview + validation for the create/edit form.
  app.post("/cron-jobs/preview", async (request, reply) => {
    const body = previewCronSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ success: false, message: "Provide a cron expression" });
    }

    const result = previewCron(body.data.cronExpression);
    if (!result.ok) {
      return reply.send({ success: true, valid: false, error: result.error });
    }
    return reply.send({ success: true, valid: true, description: result.description });
  });

  app.post(
    "/cron-jobs",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = createCronJobSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid cron job",
          errors: body.error.flatten()
        });
      }

      // The target app must exist — a job cannot point at nothing.
      const targetApp = appDatabase.getAppById(body.data.appId);
      if (!targetApp) {
        return reply.code(404).send({ success: false, message: "The selected app was not found" });
      }

      const job = appDatabase.createCronJob({
        appId: body.data.appId,
        name: body.data.name,
        cronExpression: body.data.cronExpression,
        command: body.data.command,
        enabled: body.data.enabled,
        timeoutSeconds: body.data.timeoutSeconds
      });

      return reply.code(201).send({ success: true, job });
    }
  );

  app.put("/cron-jobs/:id", async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ success: false, message: "Invalid cron job id" });
    }

    const body = updateCronJobSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        success: false,
        message: "Invalid cron job",
        errors: body.error.flatten()
      });
    }

    const updated = appDatabase.updateCronJob(params.data.id, {
      name: body.data.name,
      cronExpression: body.data.cronExpression,
      command: body.data.command,
      enabled: body.data.enabled,
      timeoutSeconds: body.data.timeoutSeconds
    });

    if (!updated) {
      return reply.code(404).send({ success: false, message: "Cron job not found" });
    }

    return reply.send({ success: true, job: updated });
  });

  app.delete("/cron-jobs/:id", async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ success: false, message: "Invalid cron job id" });
    }

    const deleted = appDatabase.deleteCronJob(params.data.id);
    if (!deleted) {
      return reply.code(404).send({ success: false, message: "Cron job not found" });
    }

    return reply.send({ success: true, message: "Cron job deleted." });
  });

  // Run a job right now, on demand — the same executor the scheduler uses,
  // so a "Run now" behaves identically to a scheduled fire and records the
  // same last-run result.
  app.post(
    "/cron-jobs/:id/run",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ success: false, message: "Invalid cron job id" });
      }

      const job = appDatabase.getCronJob(params.data.id);
      if (!job) {
        return reply.code(404).send({ success: false, message: "Cron job not found" });
      }

      const result = await runCronJob(dockerOps, job);
      appDatabase.recordCronJobRun(job.id, result);

      return reply.send({ success: true, result, job: appDatabase.getCronJob(job.id) });
    }
  );
}
