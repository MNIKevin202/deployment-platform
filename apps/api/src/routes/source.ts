import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase, StoredAppSource } from "../database.js";
import { appSourceConfigSchema } from "../schemas/source.js";
import {
  removeAppSource,
  saveAppSource,
  revalidateAppSource,
  type AppSourceServiceDeps
} from "../services/app-source-service.js";
import { SourceClientError, type SourceProviderClient } from "../services/source-provider.js";
import type { DecryptedTokenResult } from "../services/github-credential-service.js";
import { inspectRepositoryRemote, type InspectionDetection } from "../services/repository-inspection-service.js";

interface RegisterSourceRoutesOptions {
  appDatabase: AppDatabase;
  sourceServiceDeps: AppSourceServiceDeps;
  githubClient: SourceProviderClient;
  resolveCredential: () => DecryptedTokenResult;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

function serializeSource(source: StoredAppSource) {
  return {
    appId: source.appId,
    provider: source.provider,
    repositoryOwner: source.repositoryOwner,
    repositoryName: source.repositoryName,
    repositoryFullName: source.repositoryFullName,
    repositoryId: source.repositoryId,
    repositoryVisibility: source.repositoryVisibility,
    branch: source.branch,
    subdirectory: source.subdirectory,
    deploymentMode: source.deploymentMode,
    dockerfilePath: source.dockerfilePath,
    buildContext: source.buildContext,
    buildStrategy: source.buildStrategy,
    detectedProjectType: source.detectedProjectType,
    containerPort: source.containerPort,
    containerPortSource: source.containerPortSource,
    containerPortConfidence: source.containerPortConfidence,
    autoDeploy: source.autoDeploy,
    lastValidatedCommitSha: source.lastValidatedCommitSha,
    lastValidatedAt: source.lastValidatedAt,
    validationStatus: source.validationStatus,
    validationError: source.validationError,
    latestRemoteCommitSha: source.latestRemoteCommitSha,
    latestDeployedCommitSha: source.latestDeployedCommitSha,
    latestDeployedCommitMessage: source.latestDeployedCommitMessage,
    latestDeployedAt: source.latestDeployedAt,
    lastInternalHealthResult: source.lastInternalHealthResult,
    lastPublicHealthResult: source.lastPublicHealthResult,
    lastDeploymentStatus: source.lastDeploymentStatus,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  };
}

export function serializeInspection(detection: InspectionDetection) {
  return {
    detectedProjectType: detection.detectedProjectType,
    recommendedStrategy: detection.recommendedStrategy,
    presentFiles: detection.presentFiles,
    packageJson: detection.packageJson,
    warnings: detection.warnings,
    supported: detection.supported,
    unsupportedReason: detection.unsupportedReason,
    portDetection: detection.portDetection
  };
}

function safeGithubClientMessage(error: unknown): string {
  return error instanceof SourceClientError ? error.message : "Unable to reach GitHub right now.";
}

function statusCodeForClientError(error: unknown): number {
  if (!(error instanceof SourceClientError)) {
    return 502;
  }
  switch (error.kind) {
    case "invalid-token":
      return 401;
    case "insufficient-permissions":
      return 403;
    case "rate-limited":
      return 429;
    case "not-found":
      return 404;
    case "network-timeout":
      return 504;
    default:
      return 502;
  }
}

export async function registerSourceRoutes(
  fastify: FastifyInstance,
  { appDatabase, sourceServiceDeps, githubClient, resolveCredential }: RegisterSourceRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams }>(
    "/apps/:id/source",
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

      const source = appDatabase.getAppSource(app.id);

      return {
        success: true,
        source: source ? serializeSource(source) : null
      };
    }
  );

  fastify.put<{ Params: AppIdParams }>(
    "/apps/:id/source",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const parsedBody = appSourceConfigSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid source configuration",
          errors: parsedBody.error.flatten()
        });
      }

      const result = await saveAppSource(sourceServiceDeps, parsedParams.data.id, parsedBody.data);

      if (!result.success) {
        return reply.code(result.statusCode ?? 502).send({ success: false, message: result.message });
      }

      return reply.code(200).send({
        success: true,
        source: result.source ? serializeSource(result.source) : null
      });
    }
  );

  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/source/validate",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const result = await revalidateAppSource(sourceServiceDeps, parsedParams.data.id);

      if (!result.success) {
        return reply.code(result.statusCode ?? 502).send({ success: false, message: result.message });
      }

      return {
        success: true,
        source: result.source ? serializeSource(result.source) : null
      };
    }
  );

  fastify.delete<{ Params: AppIdParams }>(
    "/apps/:id/source",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const result = removeAppSource(sourceServiceDeps, parsedParams.data.id);

      if (!result.success) {
        return reply.code(result.statusCode ?? 502).send({ success: false, message: result.message });
      }

      return { success: true };
    }
  );

  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/source/inspect",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);
      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      const source = appDatabase.getAppSource(parsedParams.data.id);
      if (!source) {
        return reply.code(404).send({ success: false, message: "No GitHub source is configured for this app" });
      }

      const credential = resolveCredential();
      if (!credential.success) {
        return reply.code(409).send({
          success: false,
          message: "GitHub is not connected.",
          credentialStatus: credential.credentialStatus
        });
      }

      try {
        const commitSha = await githubClient.resolveBranchCommit(
          credential.token,
          source.repositoryOwner,
          source.repositoryName,
          source.branch
        );

        const detection = await inspectRepositoryRemote(githubClient, {
          token: credential.token,
          repositoryOwner: source.repositoryOwner,
          repositoryName: source.repositoryName,
          ref: commitSha,
          subdirectory: source.subdirectory
        });

        appDatabase.updateInspectionResult(parsedParams.data.id, {
          buildStrategy: detection.recommendedStrategy,
          detectedProjectType: detection.detectedProjectType,
          latestRemoteCommitSha: commitSha
        });

        return {
          success: true,
          commitSha,
          inspection: serializeInspection(detection)
        };
      } catch (error) {
        return reply.code(statusCodeForClientError(error)).send({
          success: false,
          message: safeGithubClientMessage(error)
        });
      }
    }
  );
}
