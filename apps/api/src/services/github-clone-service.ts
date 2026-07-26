import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMinimalEnv, runProcess, sanitizeProcessOutput } from "./process-runner.js";

export class CloneError extends Error {
  readonly stage: string;

  constructor(message: string, stage: string) {
    super(message);
    this.name = "CloneError";
    this.stage = stage;
  }
}

export const DEFAULT_CLONE_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_CLONE_MAX_OUTPUT_BYTES = 256 * 1024;

export interface CloneOptions {
  repositoryOwner: string;
  repositoryName: string;
  branch: string;
  /** Decrypted GitHub token — never logged, never written to argv. */
  token: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface CloneResult {
  /** Root scratch directory — remove this (not just checkoutDir) on cleanup. */
  workDir: string;
  /** The actual cloned working copy, inside workDir. */
  checkoutDir: string;
  /** HEAD of the freshly cloned branch, confirmed by `git rev-parse`. */
  commitSha: string;
}

// Credential helper scripts only ever contain a token already validated
// by githubTokenSchema (^[A-Za-z0-9_]+$) — this check is redundant
// defense-in-depth against ever writing an unexpected quote/newline into
// a shell script we then execute.
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_]+$/;

function buildCredentialHelperScript(token: string): string {
  if (!SAFE_TOKEN_PATTERN.test(token)) {
    throw new CloneError("Stored GitHub token has an unexpected shape", "preparing-checkout");
  }

  return `#!/bin/sh\necho "username=x-access-token"\necho "password=${token}"\n`;
}

/**
 * Creates a unique, empty scratch directory and a short-lived Git
 * credential helper inside it, then shallow-clones exactly one branch
 * into a subdirectory of that scratch space. The credential helper file
 * exists only for the duration of this call's scratch directory — the
 * caller is responsible for removing `workDir` (via `cleanupCheckout`)
 * once the build that follows is done with `checkoutDir`, success or
 * failure.
 *
 * Authentication never touches argv or the environment: the helper
 * script's own file content is what carries the token, git invokes that
 * script as a subprocess when it needs credentials, and the script's
 * path (not the token) is the only thing passed on the command line.
 * The user's real `$HOME`/global Git config is never read or modified —
 * this clone runs against an isolated, empty `HOME`.
 */
export async function cloneRepositoryBranch(options: CloneOptions): Promise<CloneResult> {
  if (options.branch.startsWith("-")) {
    throw new CloneError("Branch name is not safe to pass to git", "preparing-checkout");
  }

  const workDir = mkdtempSync(join(tmpdir(), "github-deploy-"));
  const checkoutDir = join(workDir, "repo");
  const isolatedHome = join(workDir, "home");
  const credentialHelperPath = join(workDir, "credential-helper.sh");

  try {
    writeFileSync(credentialHelperPath, buildCredentialHelperScript(options.token), {
      mode: 0o700
    });
    // Belt-and-suspenders: writeFileSync's mode option can be affected by
    // umask on some platforms, so set it explicitly too.
    chmodSync(credentialHelperPath, 0o700);

    const cloneUrl = `https://github.com/${options.repositoryOwner}/${options.repositoryName}.git`;

    const env = buildMinimalEnv({
      HOME: isolatedHome,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1"
    });

    const cloneResult = await runProcess({
      command: "git",
      args: [
        "-c",
        `credential.helper=${credentialHelperPath}`,
        "clone",
        "--branch",
        options.branch,
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
        cloneUrl,
        checkoutDir
      ],
      cwd: workDir,
      env,
      timeoutMs: options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_CLONE_MAX_OUTPUT_BYTES,
      signal: options.signal
    });

    if (cloneResult.timedOut) {
      throw new CloneError("Cloning the repository timed out", "cloning-repository");
    }
    if (cloneResult.aborted) {
      throw new CloneError("Cloning the repository was cancelled", "cloning-repository");
    }
    if (cloneResult.exitCode !== 0) {
      throw new CloneError(
        describeCloneFailure(cloneResult.exitCode, sanitizeProcessOutput(cloneResult.stderr)),
        "cloning-repository"
      );
    }

    const revParseResult = await runProcess({
      command: "git",
      args: ["-C", checkoutDir, "rev-parse", "HEAD"],
      cwd: checkoutDir,
      env,
      timeoutMs: 10_000,
      maxOutputBytes: 4096
    });

    if (revParseResult.exitCode !== 0 || !revParseResult.stdout.trim()) {
      throw new CloneError("Unable to determine the cloned commit", "cloning-repository");
    }

    return { workDir, checkoutDir, commitSha: revParseResult.stdout.trim() };
  } catch (error) {
    cleanupCheckout(workDir);
    throw error;
  }
}

function describeCloneFailure(exitCode: number | null, sanitizedStderr: string): string {
  if (/could not find remote branch|couldn't find remote ref/i.test(sanitizedStderr)) {
    return "Branch does not exist on the remote repository";
  }
  if (/repository not found/i.test(sanitizedStderr)) {
    return "Repository is inaccessible with the connected GitHub account";
  }
  if (/authentication failed|invalid username or password/i.test(sanitizedStderr)) {
    return "GitHub rejected the stored credential while cloning";
  }
  return `git clone failed (exit code ${exitCode ?? "unknown"})`;
}

/** Removes the entire scratch directory — the checkout, the credential helper, everything. */
export function cleanupCheckout(workDir: string): void {
  rmSync(workDir, { recursive: true, force: true });
}
