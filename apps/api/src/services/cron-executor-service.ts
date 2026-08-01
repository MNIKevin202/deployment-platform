import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import type { CronJobRunResult, StoredCronJob } from "../cron-job-database.js";
import { getErrorStatusCode } from "../docker-errors.js";

/** Captured output is capped so a chatty command can't bloat the database. */
const MAX_OUTPUT_BYTES = 32 * 1024;

/**
 * The Docker operations the cron executor needs — kept behind an interface
 * so the scheduler and its tests never touch a real container.
 */
export interface CronDockerOps {
  /**
   * Runs `sh -c <command>` inside the container and resolves with its exit
   * code and combined stdout+stderr. Rejects only on a Docker-level error
   * (e.g. the container is gone); a non-zero command exit is a normal
   * resolve with that code.
   */
  execCommand(
    containerName: string,
    command: string,
    timeoutMs: number
  ): Promise<{ exitCode: number; output: string; timedOut: boolean }>;
}

export function createCronDockerOps(docker: Docker): CronDockerOps {
  return {
    async execCommand(containerName, command, timeoutMs) {
      const container = docker.getContainer(containerName);

      const exec = await container.exec({
        // A single `sh -c` so the operator's command can use pipes,
        // redirects, and env vars exactly as they would in a shell. It runs
        // as whatever user the container runs as — bounded to that
        // container, never the host.
        Cmd: ["sh", "-c", command],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false
      });

      const stream = await exec.start({ hijack: true, stdin: false, Tty: false });

      const chunks: Buffer[] = [];
      let total = 0;
      const sink = new PassThrough();
      sink.on("data", (chunk: Buffer) => {
        // Keep only up to the cap; keep counting so nothing downstream
        // stalls on backpressure.
        if (total < MAX_OUTPUT_BYTES) {
          chunks.push(chunk);
          total += chunk.length;
        }
      });

      // stdout and stderr are demuxed into the same sink so the operator
      // sees the command's full output, in order, the way a terminal would.
      docker.modem.demuxStream(stream, sink, sink);

      let timedOut = false;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void };
          destroyable.destroy?.();
          resolve();
        }, timeoutMs);

        stream.on("end", () => {
          clearTimeout(timer);
          resolve();
        });
        stream.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      let output = Buffer.concat(chunks).toString("utf8");
      if (total >= MAX_OUTPUT_BYTES) {
        output += "\n… output truncated …";
      }

      if (timedOut) {
        return { exitCode: 124, output, timedOut: true };
      }

      const inspected = await exec.inspect();
      return { exitCode: inspected.ExitCode ?? 1, output, timedOut: false };
    }
  };
}

/**
 * Runs one cron job's command and returns a structured result. Never
 * throws — a missing container, a Docker error, or a command failure all
 * become a recorded result, because a scheduled run has no caller to catch
 * an exception and the outcome must be stored either way.
 */
export async function runCronJob(
  dockerOps: CronDockerOps,
  job: StoredCronJob,
  now: () => Date = () => new Date()
): Promise<CronJobRunResult> {
  const ranAt = now().toISOString();
  const startedMs = Date.now();

  // A job whose app was never deployed (or whose container is gone) is
  // skipped, not failed — there is nothing wrong with the job itself.
  if (!job.containerName) {
    return {
      status: "skipped",
      exitCode: null,
      output: "The app has no container to run this command in.",
      durationMs: 0,
      ranAt
    };
  }

  const timeoutMs = Math.max(1, job.timeoutSeconds) * 1000;

  try {
    const result = await dockerOps.execCommand(job.containerName, job.command, timeoutMs);
    const durationMs = Date.now() - startedMs;

    if (result.timedOut) {
      return { status: "timeout", exitCode: null, output: result.output, durationMs, ranAt };
    }

    return {
      status: result.exitCode === 0 ? "success" : "failed",
      exitCode: result.exitCode,
      output: result.output,
      durationMs,
      ranAt
    };
  } catch (error) {
    const durationMs = Date.now() - startedMs;

    // A 404 means the container is gone — that's a skip, not a failure of
    // the command.
    if (getErrorStatusCode(error) === 404) {
      return {
        status: "skipped",
        exitCode: null,
        output: "The app's container no longer exists.",
        durationMs,
        ranAt
      };
    }

    return {
      status: "failed",
      exitCode: null,
      output: `Unable to run the command: ${error instanceof Error ? error.message : String(error)}`,
      durationMs,
      ranAt
    };
  }
}
