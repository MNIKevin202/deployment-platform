import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import type { RecordEventFn } from "../services/deployment-event-service.js";
import { submitBrowserDiagnosticsSchema } from "../schemas/performance-diagnostics.js";
import {
  type DetailedHttpProbeClient,
  probeInternalContainer,
  probePublicRoute,
  diagnosePerformance,
  sanitizeResourceEntry,
  summarizeResourcesByCategory,
  topSlowestResources,
  type SanitizedResourceEntry
} from "../services/performance-diagnostics-service.js";
import type { StoredPerformanceDiagnostic } from "../performance-diagnostics-database.js";

interface RegisterPerformanceDiagnosticsRoutesOptions {
  appDatabase: AppDatabase;
  httpProbeClient: DetailedHttpProbeClient;
  recordEvent: RecordEventFn;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
interface AppIdParams {
  id: string;
}

const diagnosticIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  diagnosticId: z.coerce.number().int().positive()
});
interface DiagnosticIdParams {
  id: string;
  diagnosticId: string;
}

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional().default(20)
});

function serializeDiagnostic(record: StoredPerformanceDiagnostic) {
  return {
    id: record.id,
    appId: record.appId,
    createdAt: record.createdAt,
    publicProbe: record.publicProbe,
    internalProbe: record.internalProbe,
    browser: {
      submittedAt: record.browserSubmittedAt,
      available: record.browserAvailable,
      dnsMs: record.browserDnsMs,
      tlsMs: record.browserTlsMs,
      ttfbMs: record.browserTtfbMs,
      pageLoadMs: record.browserPageLoadMs,
      totalNavigationMs: record.browserTotalNavigationMs,
      transferBytes: record.browserTransferBytes
    },
    resourceSummary: record.resourceSummary,
    topResources: record.topResources,
    diagnosis: {
      category: record.diagnosisCategory,
      message: record.diagnosisMessage,
      evidence: record.evidence
    }
  };
}

export async function registerPerformanceDiagnosticsRoutes(
  fastify: FastifyInstance,
  { appDatabase, httpProbeClient, recordEvent }: RegisterPerformanceDiagnosticsRoutesOptions
): Promise<void> {
  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/performance-diagnostics/server",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);
      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      recordEvent({
        appId: app.id,
        eventType: "performance-test-started",
        severity: "info",
        message: `Performance diagnostics started for "${app.name}"`
      });

      try {
        const internalProbeResult = await probeInternalContainer(
          httpProbeClient,
          app.containerName ?? "",
          app.containerPort,
          5000
        );

        const publicProbeResult = app.domain
          ? await probePublicRoute(httpProbeClient, app.domain, { timeoutMs: 10000 })
          : {
              ok: false,
              totalMs: null,
              dnsMs: null,
              connectMs: null,
              tlsMs: null,
              ttfbMs: null,
              downloadMs: null,
              statusCode: null,
              responseBytes: null,
              redirectCount: 0,
              finalHost: null,
              error: "This app has no public domain assigned."
            };

        const diagnosis = diagnosePerformance({
          browser: null,
          publicProbe: publicProbeResult,
          internalProbe: internalProbeResult,
          slowestThirdPartyMs: null,
          slowestFirstPartyResourceMs: null
        });

        const created = appDatabase.createDiagnosticRun({
          appId: app.id,
          publicProbe: publicProbeResult,
          internalProbe: { ...internalProbeResult, port: app.containerPort },
          diagnosisCategory: diagnosis.category,
          diagnosisMessage: diagnosis.message,
          evidence: diagnosis.evidence
        });

        recordEvent({
          appId: app.id,
          eventType: "performance-test-completed",
          severity: "info",
          message: `Performance diagnostics completed for "${app.name}" (${diagnosis.category})`,
          metadata: {
            publicTotalMs: publicProbeResult.totalMs,
            publicTtfbMs: publicProbeResult.ttfbMs,
            publicStatusCode: publicProbeResult.statusCode,
            internalTotalMs: internalProbeResult.totalMs,
            internalTtfbMs: internalProbeResult.ttfbMs,
            internalStatusCode: internalProbeResult.statusCode,
            diagnosisCategory: diagnosis.category
          }
        });

        return { success: true, diagnostic: serializeDiagnostic(created) };
      } catch {
        recordEvent({
          appId: app.id,
          eventType: "performance-test-failed",
          severity: "error",
          message: `Performance diagnostics failed for "${app.name}"`
        });
        return reply.code(502).send({ success: false, message: "Unable to complete performance diagnostics right now." });
      }
    }
  );

  fastify.post<{ Params: DiagnosticIdParams }>(
    "/apps/:id/performance-diagnostics/:diagnosticId/browser",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = diagnosticIdParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app or diagnostic id" });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);
      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      const existing = appDatabase.getDiagnosticById(parsedParams.data.diagnosticId);
      if (!existing || existing.appId !== app.id) {
        return reply.code(404).send({ success: false, message: "Performance diagnostic run not found for this app" });
      }

      const parsedBody = submitBrowserDiagnosticsSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid browser timing submission",
          errors: parsedBody.error.flatten()
        });
      }

      const { navigation, resources } = parsedBody.data;

      const sanitizedResources: SanitizedResourceEntry[] = [];
      for (const raw of resources) {
        const sanitized = sanitizeResourceEntry(
          {
            url: raw.url,
            initiatorType: raw.initiatorType,
            startMs: raw.startMs,
            durationMs: raw.durationMs,
            transferBytes: raw.transferBytes,
            statusOk: raw.statusOk
          },
          app.domain ?? ""
        );
        if (sanitized) {
          sanitizedResources.push(sanitized);
        }
      }

      const resourceSummary = summarizeResourcesByCategory(sanitizedResources);
      const topResources = topSlowestResources(sanitizedResources);

      const thirdParty = sanitizedResources.filter((r) => !r.firstParty);
      const firstParty = sanitizedResources.filter((r) => r.firstParty);
      const slowestThirdPartyMs = thirdParty.length > 0 ? Math.max(...thirdParty.map((r) => r.durationMs)) : null;
      const slowestFirstPartyResourceMs = firstParty.length > 0 ? Math.max(...firstParty.map((r) => r.durationMs)) : null;

      const diagnosis = diagnosePerformance({
        browser: {
          available: navigation.available,
          ttfbMs: navigation.ttfbMs,
          totalLoadMs: navigation.pageLoadMs,
          dnsMs: navigation.dnsMs,
          tlsMs: navigation.tlsMs
        },
        publicProbe: existing.publicProbe,
        internalProbe: existing.internalProbe,
        slowestThirdPartyMs,
        slowestFirstPartyResourceMs
      });

      const updated = appDatabase.attachBrowserDiagnostics(existing.id, app.id, {
        available: navigation.available,
        dnsMs: navigation.dnsMs,
        tlsMs: navigation.tlsMs,
        ttfbMs: navigation.ttfbMs,
        pageLoadMs: navigation.pageLoadMs,
        totalNavigationMs: navigation.totalNavigationMs,
        transferBytes: navigation.transferBytes,
        resourceSummary,
        topResources,
        diagnosisCategory: diagnosis.category,
        diagnosisMessage: diagnosis.message,
        evidence: diagnosis.evidence
      });

      if (!updated) {
        return reply.code(404).send({ success: false, message: "Performance diagnostic run not found for this app" });
      }

      recordEvent({
        appId: app.id,
        eventType: "performance-test-completed",
        severity: "info",
        message: `Browser performance timing recorded for "${app.name}" (${diagnosis.category})`,
        metadata: {
          browserTotalMs: navigation.totalNavigationMs,
          browserTtfbMs: navigation.ttfbMs,
          diagnosisCategory: diagnosis.category
        }
      });

      return { success: true, diagnostic: serializeDiagnostic(updated) };
    }
  );

  fastify.get<{ Params: AppIdParams }>(
    "/apps/:id/performance-diagnostics/latest",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);
      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      const latest = appDatabase.getLatestDiagnostic(app.id);
      return { success: true, diagnostic: latest ? serializeDiagnostic(latest) : null };
    }
  );

  fastify.get<{ Params: AppIdParams; Querystring: { limit?: string } }>(
    "/apps/:id/performance-diagnostics/history",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);
      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      const parsedQuery = historyQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        return reply.code(400).send({ success: false, message: "Invalid query" });
      }

      const history = appDatabase.listDiagnosticHistory(app.id, parsedQuery.data.limit);
      return { success: true, history: history.map(serializeDiagnostic) };
    }
  );
}
