import { readdirSync } from "node:fs";
import type Docker from "dockerode";
import { getErrorStatusCode } from "../docker-errors.js";

export interface BuildImageInput {
  contextPath: string;
  /** Relative to contextPath — never an absolute host path. */
  dockerfileRelativePath: string;
  tag: string;
  timeoutMs: number;
  /** Caps how much of the build's own JSON-stream log text is retained. */
  maxLogBytes: number;
}

export interface BuildImageResult {
  /** Sanitization happens in the caller (process-runner's sanitizer); this is raw build-stream text. */
  log: string;
  truncated: boolean;
}

export class BuildImageError extends Error {
  readonly log: string;

  constructor(message: string, log: string) {
    super(message);
    this.name = "BuildImageError";
    this.log = log;
  }
}

/**
 * The narrow Docker operations a GitHub deployment's *build* step needs,
 * kept separate from `RedeployDockerOps` (which already covers
 * container create/start/inspect/remove/rename/volume-ensure — reused
 * as-is by github-deploy-service.ts) so this interface stays small and
 * fake-able in tests.
 */
export interface GithubBuildDockerOps {
  buildImage(input: BuildImageInput): Promise<BuildImageResult>;
  imageExists(tag: string): Promise<boolean>;
}

export function createGithubBuildDockerOps(docker: Docker): GithubBuildDockerOps {
  return {
    async buildImage(input) {
      let entries: string[];

      try {
        entries = readdirSync(input.contextPath);
      } catch (error) {
        throw new BuildImageError(
          `Unable to read the prepared build context: ${error instanceof Error ? error.message : "unknown error"}`,
          ""
        );
      }

      const stream = await docker.buildImage(
        { context: input.contextPath, src: entries },
        { t: input.tag, dockerfile: input.dockerfileRelativePath }
      );

      const logLines: string[] = [];
      let logLength = 0;
      let truncated = false;
      let buildErrorMessage: string | null = null;

      function appendLog(text: string) {
        if (logLength >= input.maxLogBytes) {
          truncated = true;
          return;
        }
        logLines.push(text);
        logLength += text.length;
      }

      await new Promise<void>((resolvePromise, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void };
          destroyable.destroy?.();
          reject(new BuildImageError(`Image build timed out after ${input.timeoutMs}ms`, logLines.join("\n")));
        }, input.timeoutMs);

        docker.modem.followProgress(
          stream,
          (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (err) {
              reject(new BuildImageError(err instanceof Error ? err.message : "Image build failed", logLines.join("\n")));
              return;
            }

            if (buildErrorMessage) {
              reject(new BuildImageError(buildErrorMessage, logLines.join("\n")));
              return;
            }

            resolvePromise();
          },
          (event: { stream?: string; error?: string }) => {
            if (typeof event.stream === "string") {
              appendLog(event.stream);
            }
            if (typeof event.error === "string" && !buildErrorMessage) {
              buildErrorMessage = event.error;
            }
          }
        );
      });

      return { log: logLines.join("\n"), truncated };
    },

    async imageExists(tag) {
      try {
        await docker.getImage(tag).inspect();
        return true;
      } catch (error) {
        if (getErrorStatusCode(error) === 404) {
          return false;
        }
        throw error;
      }
    }
  };
}
