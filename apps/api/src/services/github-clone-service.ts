import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMinimalEnv, runProcess, sanitizeProcessOutput, type ProcessRunResult } from "./process-runner.js";

/**
 * Safe, structured facts about why a clone-related process failed —
 * everything a caller needs to persist a useful deployment event without
 * ever needing the raw stderr/stdout (which may still contain repository
 * path fragments or other noise even after sanitization, so it is
 * deliberately never included here — only short, capped summaries are).
 * Never carries a token, header, credential-helper output, or temp
 * directory path.
 */
export interface CloneDiagnostics {
  stage: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** False only when the process never actually started (e.g. git is not installed). */
  processStarted: boolean;
  spawnErrorCode?: string;
  sanitizedStderrSummary?: string;
  sanitizedStdoutSummary?: string;
}

export class CloneError extends Error {
  readonly stage: string;
  readonly diagnostics: CloneDiagnostics;

  constructor(message: string, stage: string, diagnostics: CloneDiagnostics) {
    super(message);
    this.name = "CloneError";
    this.stage = stage;
    this.diagnostics = diagnostics;
  }
}

const MAX_SUMMARY_LENGTH = 300;

/** Collapses to a single line and caps length — for event metadata, never for display of full logs. */
function summarize(text: string): string | undefined {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  return collapsed.length > MAX_SUMMARY_LENGTH ? `${collapsed.slice(0, MAX_SUMMARY_LENGTH)}…` : collapsed;
}

/** For failures that happen before any process is ever spawned (validation errors). */
function noProcessDiagnostics(stage: string): CloneDiagnostics {
  return {
    stage,
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    processStarted: false
  };
}

function buildDiagnostics(stage: string, result: ProcessRunResult): CloneDiagnostics {
  return {
    stage,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    processStarted: result.processStarted,
    spawnErrorCode: result.spawnError?.code,
    sanitizedStderrSummary: summarize(sanitizeProcessOutput(result.stderr)),
    sanitizedStdoutSummary: result.exitCode !== 0 ? summarize(sanitizeProcessOutput(result.stdout)) : undefined
  };
}

export const DEFAULT_CLONE_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_CLONE_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * The `git` executable to invoke — always "git" in production (resolved
 * via PATH, same as every other call in this file). This exists purely
 * so tests can inject a guaranteed-nonexistent absolute path to force a
 * deterministic ENOENT, instead of relying on clearing PATH — which
 * does not reliably work on every platform (macOS in particular falls
 * back to a default system PATH containing a real `git` when the
 * child's PATH is empty). Never exposed through any HTTP route/schema
 * and never user-configurable — it is an internal/test-only override.
 */
export const DEFAULT_GIT_EXECUTABLE = "git";

export interface CloneOptions {
  repositoryOwner: string;
  repositoryName: string;
  branch: string;
  /** Decrypted GitHub token — never logged, never written to argv. */
  token: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Test-only override — see DEFAULT_GIT_EXECUTABLE. */
  gitExecutable?: string;
  /**
   * Test-only override for the clone URL — same rationale and the same
   * guarantees as `gitExecutable`: never exposed through any HTTP
   * route/schema, never user-configurable, exists purely so tests (and
   * the local acceptance fixture) can exercise the REAL clone
   * mechanism — including real HTTP authentication via the real
   * credential helper — against a local, controlled git server instead
   * of github.com. Production callers never pass this, so they always
   * clone from the real `https://github.com/{owner}/{repo}.git`.
   */
  cloneUrlOverride?: string;
}

export interface CloneResult {
  /** Root scratch directory — remove this (not just checkoutDir) on cleanup. */
  workDir: string;
  /** The actual cloned working copy, inside workDir. */
  checkoutDir: string;
  /** HEAD of the freshly cloned branch, confirmed by `git rev-parse`. */
  commitSha: string;
}

// This is a SHELL-SAFETY check, not a token-FORMAT check — it exists only
// to guarantee `token` cannot break out of the double-quoted
// `echo "password=${token}"` line below, and it must accept ANY token
// resolveGithubToken() hands back, regardless of source. Earlier this
// instead required the token to match the same narrow pattern the
// manual-PAT entry form validates against (githubTokenSchema, "already
// validated" by that PAT-only schema) — but a freshly-minted GitHub App
// installation token (github-token-service.ts's resolveGithubToken,
// source: "installation") is never entered through that form and was
// never checked against it, so that assumption was simply wrong for it.
// The credential helper accepts whatever resolveGithubToken() resolved —
// installation token or PAT — without re-deriving, re-parsing, or
// re-validating it against either shape; only genuinely dangerous
// characters (control characters/newlines, double quotes, backslashes)
// are rejected.
function isSafeForCredentialHelperScript(token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return !token.includes('"') && !token.includes("\\");
}

// Implements Git's credential-helper protocol correctly: git invokes the
// helper as `<helper> get|store|erase`. Only `get` should ever emit
// credentials — `store`/`erase` are git's normal post-clone caching
// calls, and since this helper caches nothing itself, they are safely
// ignored (git does not require a helper to act on them). Responding to
// every operation with the same username/password lines (the previous
// version's bug) is harmless in practice but not a correct
// implementation of the protocol, so it is fixed here.
function buildCredentialHelperScript(token: string): string {
  if (!isSafeForCredentialHelperScript(token)) {
    throw new CloneError(
      "The resolved GitHub credential contains characters that cannot be used safely for cloning",
      "preparing-checkout",
      noProcessDiagnostics("preparing-checkout")
    );
  }

  return `#!/bin/sh\nif [ "$1" = "get" ]; then\n  echo "username=x-access-token"\n  echo "password=${token}"\nfi\nexit 0\n`;
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
    throw new CloneError(
      "Branch name is not safe to pass to git",
      "preparing-checkout",
      noProcessDiagnostics("preparing-checkout")
    );
  }

  const gitExecutable = options.gitExecutable ?? DEFAULT_GIT_EXECUTABLE;
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

    const cloneUrl =
      options.cloneUrlOverride ?? `https://github.com/${options.repositoryOwner}/${options.repositoryName}.git`;

    const env = buildMinimalEnv({
      HOME: isolatedHome,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1"
    });

    const cloneResult = await runProcess({
      command: gitExecutable,
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

    if (!cloneResult.processStarted) {
      throw new CloneError(
        describeSpawnFailure(cloneResult.spawnError?.code),
        "cloning-repository",
        buildDiagnostics("cloning-repository", cloneResult)
      );
    }
    if (cloneResult.timedOut) {
      throw new CloneError(
        "Cloning the repository timed out",
        "cloning-repository",
        buildDiagnostics("cloning-repository", cloneResult)
      );
    }
    if (cloneResult.aborted) {
      throw new CloneError(
        "Cloning the repository was cancelled",
        "cloning-repository",
        buildDiagnostics("cloning-repository", cloneResult)
      );
    }
    if (cloneResult.exitCode !== 0) {
      throw new CloneError(
        describeCloneFailure(options.branch, cloneResult.exitCode, sanitizeProcessOutput(cloneResult.stderr)),
        "cloning-repository",
        buildDiagnostics("cloning-repository", cloneResult)
      );
    }

    const revParseResult = await runProcess({
      command: gitExecutable,
      args: ["-C", checkoutDir, "rev-parse", "HEAD"],
      cwd: checkoutDir,
      env,
      timeoutMs: 10_000,
      maxOutputBytes: 4096
    });

    if (!revParseResult.processStarted) {
      throw new CloneError(
        describeSpawnFailure(revParseResult.spawnError?.code),
        "cloning-repository",
        buildDiagnostics("cloning-repository", revParseResult)
      );
    }
    if (revParseResult.exitCode !== 0 || !revParseResult.stdout.trim()) {
      throw new CloneError(
        "Unable to determine the cloned commit",
        "cloning-repository",
        buildDiagnostics("cloning-repository", revParseResult)
      );
    }

    return { workDir, checkoutDir, commitSha: revParseResult.stdout.trim() };
  } catch (error) {
    cleanupCheckout(workDir);
    throw error;
  }
}

/** The process could not even be started — git itself, not the clone, is the problem. */
export function describeSpawnFailure(spawnErrorCode: string | undefined): string {
  if (spawnErrorCode === "ENOENT") {
    return "Git executable was not found";
  }
  if (spawnErrorCode) {
    return `Git could not be started (${spawnErrorCode})`;
  }
  return "Git could not be started";
}

export function describeCloneFailure(branch: string, exitCode: number | null, sanitizedStderr: string): string {
  if (/could not find remote branch|couldn't find remote ref/i.test(sanitizedStderr)) {
    return `Branch "${branch}" was not found`;
  }
  if (/repository not found/i.test(sanitizedStderr)) {
    return "Repository was not found or access was denied";
  }
  if (/authentication failed|invalid username or password/i.test(sanitizedStderr)) {
    return "GitHub authentication failed";
  }
  if (
    /could not resolve host|network is unreachable|connection timed out|ssl certificate problem|unable to access|failed to connect/i.test(
      sanitizedStderr
    )
  ) {
    return "TLS/network failure while contacting GitHub";
  }
  if (exitCode !== null) {
    return `Git clone exited with code ${exitCode}`;
  }
  return "Git clone failed for an unknown reason";
}

/** Removes the entire scratch directory — the checkout, the credential helper, everything. */
export function cleanupCheckout(workDir: string): void {
  rmSync(workDir, { recursive: true, force: true });
}

export interface GitAvailability {
  available: boolean;
  version?: string;
  reason?: string;
}

/**
 * Runs `git --version` with a short timeout — used once at API startup
 * (a clear, immediate signal in the logs rather than only discovering
 * this the first time an operator tries to deploy) and can also be
 * called immediately before a clone for the same clear, controlled
 * error instead of a generic ENOENT-derived message.
 *
 * `gitExecutable` is a test-only override (see DEFAULT_GIT_EXECUTABLE) —
 * production startup/preflight callers should never pass it, so they
 * always get the real, PATH-resolved "git".
 */
export async function verifyGitAvailable(gitExecutable: string = DEFAULT_GIT_EXECUTABLE): Promise<GitAvailability> {
  const result = await runProcess({
    command: gitExecutable,
    args: ["--version"],
    env: buildMinimalEnv(),
    timeoutMs: 5_000,
    maxOutputBytes: 4096
  });

  if (!result.processStarted) {
    return {
      available: false,
      reason: describeSpawnFailure(result.spawnError?.code)
    };
  }

  if (result.exitCode !== 0) {
    return { available: false, reason: `git --version exited with code ${result.exitCode}` };
  }

  return { available: true, version: result.stdout.trim() };
}
