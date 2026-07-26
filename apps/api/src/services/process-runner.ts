import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/**
 * The one place in this codebase that shells out to an external binary
 * (`git`, later possibly others). Every caller must go through this —
 * never `child_process.exec`, never a hand-built command string, never
 * `shell: true`. Arguments are always passed as an array to `spawn`, so
 * there is no shell to inject into in the first place.
 */

export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd?: string;
  /**
   * The *complete* environment for the child process — never merged
   * with the parent's `process.env` implicitly. Callers that need PATH
   * or similar should build it explicitly via `buildMinimalEnv`. This
   * is deliberate: a git clone's child process should never inherit
   * unrelated secrets that happen to be in this API process's own
   * environment.
   */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface ProcessSpawnError {
  /** Node's errno code, e.g. "ENOENT" when the executable does not exist. */
  code?: string;
  /** Sanitized — already run through sanitizeProcessOutput. */
  message: string;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  /**
   * False only when the child process never actually started (e.g. the
   * executable does not exist). Callers must check this before treating
   * `exitCode: null` as "still ambiguous" — a `false` here means the
   * failure happened before any process existed at all, which is a
   * distinct case from a timeout, an abort, or a process that ran and
   * exited nonzero.
   */
  processStarted: boolean;
  /** Only set when the process could not be spawned at all. */
  spawnError: ProcessSpawnError | null;
}

/** Minimal, explicit environment — PATH plus only what the caller asks for. */
export function buildMinimalEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};

  if (process.env.PATH) {
    base.PATH = process.env.PATH;
  }

  return { ...base, ...overrides };
}

const SANITIZE_LINE_PATTERN =
  /token|authorization|password|secret|credential|encryption[ _-]?key|cookie/i;

/**
 * Drops any output line that looks like it might carry a credential
 * before it is ever logged or recorded as deployment-event metadata.
 * Deliberately line-based and conservative — losing an unrelated line
 * that happens to mention "password" in passing is an acceptable cost
 * for never persisting a real secret.
 */
export function sanitizeProcessOutput(text: string): string {
  return text
    .split("\n")
    .filter((line) => !SANITIZE_LINE_PATTERN.test(line))
    .join("\n");
}

function validateCwd(cwd: string | undefined): void {
  if (!cwd) {
    return;
  }

  if (!existsSync(cwd)) {
    throw new Error("Working directory does not exist");
  }

  if (!statSync(cwd).isDirectory()) {
    throw new Error("Working directory is not a directory");
  }
}

/**
 * Runs `command` with `args` (never through a shell), bounding both
 * wall-clock time and captured output. Never throws for a nonzero exit
 * code or a timeout — callers inspect `exitCode`/`timedOut`/`aborted` and
 * decide what that means for their own stage. A process error (e.g. the
 * binary doesn't exist) is folded into the result the same way, with the
 * underlying error's message run through the same sanitizer as stderr.
 *
 * Precondition failures (currently: an invalid working directory) are a
 * different case — those mean the call was misused, not that the
 * process ran and failed, so they surface as a *rejected* promise rather
 * than a result object. `runProcess` is declared `async` specifically so
 * that a synchronous throw from `validateCwd` — which runs before any
 * child process is spawned — is automatically converted into a
 * rejection rather than an exception thrown before a promise exists.
 * Every caller can therefore handle every failure path uniformly with
 * `await`/`catch`, and no child process ever starts before this check
 * has passed.
 */
export async function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  validateCwd(options.cwd);

  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawned = false;

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.on("spawn", () => {
      spawned = true;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    function append(chunk: Buffer, which: "stdout" | "stderr") {
      const text = chunk.toString("utf8");

      if (which === "stdout") {
        if (stdout.length >= options.maxOutputBytes) {
          truncated = true;
          return;
        }
        stdout += text;
        if (stdout.length > options.maxOutputBytes) {
          stdout = stdout.slice(0, options.maxOutputBytes);
          truncated = true;
        }
      } else {
        if (stderr.length >= options.maxOutputBytes) {
          truncated = true;
          return;
        }
        stderr += text;
        if (stderr.length > options.maxOutputBytes) {
          stderr = stderr.slice(0, options.maxOutputBytes);
          truncated = true;
        }
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));

    function finish(result: ProcessRunResult) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      resolvePromise(result);
    }

    child.on("error", (error: NodeJS.ErrnoException) => {
      const sanitizedMessage = sanitizeProcessOutput(error.message);
      finish({
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n[process error: ${sanitizedMessage}]`,
        timedOut,
        aborted,
        truncated,
        processStarted: spawned,
        spawnError: { code: error.code, message: sanitizedMessage }
      });
    });

    child.on("close", (code, signal) => {
      finish({
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        aborted,
        truncated,
        processStarted: true,
        spawnError: null
      });
    });
  });
}
