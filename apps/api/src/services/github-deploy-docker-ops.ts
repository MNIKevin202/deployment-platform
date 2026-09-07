import { readdirSync } from "node:fs";
import { relative, sep } from "node:path";
import tar from "tar-fs";
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
  /**
   * Receives each chunk of build output as it arrives, so a caller can
   * track Docker's own "Step X/Y" counter live. Optional — omitting it
   * leaves build behaviour completely unchanged.
   */
  onOutput?: (chunk: string) => void;
  /**
   * When true, the build ignores Docker's layer cache entirely. Used both
   * for the automatic recovery from a corrupt cache (a missing parent
   * snapshot poisons every cached build until a no-cache build rebuilds
   * the chain) and for the operator's explicit "Deploy without cache".
   * Omitted/false keeps the normal, cache-using build.
   */
  noCache?: boolean;
}

export interface BuildImageResult {
  /** Sanitization happens in the caller (process-runner's sanitizer); this is raw build-stream text. */
  log: string;
  truncated: boolean;
}

/**
 * Whether a build failure is a known, safe-to-retry cache corruption rather
 * than a genuine problem with the code being built.
 *
 * The canonical case (seen live on Docker 29 + the containerd snapshotter):
 *
 *   NotFound: parent snapshot sha256:… does not exist: not found
 *
 * A cached build resolves against a layer whose parent snapshot was pruned
 * out from under it, so it fails instantly and deterministically — and,
 * because the poisoned record survives, EVERY later cached build fails the
 * same way. A single no-cache build rebuilds the chain from scratch and
 * clears it. This is deliberately narrow: it matches only snapshot/cache
 * -integrity phrasing, never an ordinary `RUN … exit code 1`, so a real
 * build error is never silently retried and hidden.
 */
export function isRecoverableBuildCacheError(message: string): boolean {
  const text = message.toLowerCase();

  return (
    // parent snapshot sha256:… does not exist
    /parent snapshot .* does not exist/.test(text) ||
    // failed to prepare … : parent snapshot … does not exist
    (text.includes("snapshot") && text.includes("does not exist")) ||
    // failed to get snapshotter / snapshot … : not found
    (text.includes("snapshot") && text.includes("not found")) ||
    // failed to prepare extraction snapshot …
    text.includes("failed to prepare extraction snapshot")
  );
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
      // Confirm the prepared context is readable before streaming it.
      try {
        readdirSync(input.contextPath);
      } catch (error) {
        throw new BuildImageError(
          `Unable to read the prepared build context: ${error instanceof Error ? error.message : "unknown error"}`,
          ""
        );
      }

      // Pack the build context ourselves and hand Docker a raw tar STREAM.
      //
      // We deliberately do NOT use dockerode's `{ context, src }` shortcut.
      // Its client-side .dockerignore handling (util.prepareBuildContext)
      // filters the top-level entries through the repo's .dockerignore BEFORE
      // the tar is sent — and a .dockerignore that lists "Dockerfile" (the
      // standard way to keep it out of `COPY . .`) makes it strip the
      // Dockerfile itself, so the daemon then fails almost instantly with
      // "Cannot locate specified Dockerfile". Docker's own CLI never does this:
      // the daemon always keeps the referenced Dockerfile and applies
      // .dockerignore server-side (for COPY). Packing the whole context and
      // letting the daemon filter reproduces that behaviour exactly, and
      // guarantees the configured Dockerfile is present in the context — which
      // is what makes a subdirectory/monorepo Dockerfile build work.
      const context = input.contextPath;
      const tarStream = tar.pack(context, {
        // .git is never part of a build and can be large; everything else is
        // left for the daemon to apply .dockerignore to, matching `docker build`.
        ignore: (name: string) => {
          const rel = relative(context, name);
          return rel === ".git" || rel.startsWith(`.git${sep}`);
        }
      });

      const stream = await docker.buildImage(tarStream, {
        t: input.tag,
        dockerfile: input.dockerfileRelativePath,
        // dockerode forwards this as the /build API's `nocache` query
        // param. Only sent when requested, so a normal build is byte-for-
        // byte unchanged.
        ...(input.noCache ? { nocache: true } : {})
      });

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

              // Progress reporting must never be able to break a build, so
              // a throwing listener is swallowed rather than allowed to
              // reject the whole deployment.
              try {
                input.onOutput?.(event.stream);
              } catch {
                // Ignored deliberately — see above.
              }
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
