import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BuildStrategy } from "../app-source-database.js";
import { joinRepoPath, resolveWithinRoot } from "./path-security.js";
import type { SourceProviderClient } from "./source-provider.js";

/**
 * Every manifest/marker file this phase knows how to recognize.
 * Presence-only for most of these — content is only ever read for
 * `package.json` (to find build/start scripts and pick a package
 * manager), `Dockerfile` (for port detection — see below), and a small,
 * bounded set of entry-point files (also for port detection), and even
 * then only up to the bounded size enforced by
 * `SourceProviderClient.getFileContents`.
 */
export const INSPECTABLE_FILES = [
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "poetry.lock",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "index.html"
] as const;

/**
 * Candidate entry-point files consulted, conservatively, for a literal
 * `.listen(N)`-style port — never a recursive repository scan. Bounded
 * to this fixed, small list; each file's content is capped at
 * MAX_SOURCE_FILE_BYTES before it is ever pattern-matched.
 */
export const PORT_SOURCE_CANDIDATE_FILES = [
  "server.js",
  "server.ts",
  "app.js",
  "app.ts",
  "index.js",
  "index.ts",
  "src/server.js",
  "src/server.ts",
  "src/index.js",
  "src/index.ts"
] as const;

const MAX_SOURCE_FILE_BYTES = 64 * 1024;
const MAX_DOCKERFILE_BYTES = 64 * 1024;

export type DetectedProjectType =
  | "dockerfile"
  | "nodejs"
  | "static"
  | "docker-compose"
  | "python"
  | "go"
  | "rust"
  | "php"
  | "ruby"
  | "java"
  | "unknown";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageJsonSummary {
  packageManager: PackageManager;
  hasBuildScript: boolean;
  hasStartScript: boolean;
}

export type PortDetectionSource =
  | "dockerfile-expose"
  | "dockerfile-env"
  | "package-script"
  | "source-code"
  | "framework-default"
  | "platform-default"
  | "none";

export type PortDetectionConfidence = "high" | "medium" | "low" | "none";

/**
 * A structured, safe port suggestion — never an executed or trusted
 * value. Evidence is a short, human-readable description of *where* a
 * port was found (e.g. "Dockerfile EXPOSE 3000"), never a raw source
 * excerpt or full file content. The operator must always be able to see
 * and override this before it is ever saved or deployed.
 */
export interface PortDetectionResult {
  detectedPort: number | null;
  source: PortDetectionSource;
  confidence: PortDetectionConfidence;
  evidence: string[];
  warnings: string[];
}

export interface InspectionDetection {
  detectedProjectType: DetectedProjectType;
  recommendedStrategy: BuildStrategy;
  presentFiles: string[];
  packageJson: PackageJsonSummary | null;
  warnings: string[];
  supported: boolean;
  unsupportedReason: string | null;
  portDetection: PortDetectionResult;
}

function pickPackageManager(presentFiles: Set<string>): PackageManager {
  if (presentFiles.has("pnpm-lock.yaml")) return "pnpm";
  if (presentFiles.has("yarn.lock")) return "yarn";
  if (presentFiles.has("bun.lock") || presentFiles.has("bun.lockb")) return "bun";
  return "npm";
}

function parsePackageJsonScripts(raw: string): { hasBuildScript: boolean; hasStartScript: boolean } {
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
    return {
      hasBuildScript: typeof scripts.build === "string" && scripts.build.trim().length > 0,
      hasStartScript: typeof scripts.start === "string" && scripts.start.trim().length > 0
    };
  } catch {
    return { hasBuildScript: false, hasStartScript: false };
  }
}

// ============================================================
// Port detection — Dockerfile
// ============================================================

const MIN_PORT = 1;
const MAX_PORT = 65535;

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/**
 * Text-only line scanning — the Dockerfile is never parsed as shell,
 * never executed, and never interpreted beyond literal regex matches
 * against each line. Bounded to MAX_DOCKERFILE_BYTES before scanning.
 */
function boundedText(content: string, maxBytes: number): string {
  return content.length > maxBytes ? content.slice(0, maxBytes) : content;
}

function extractDockerfileExposePorts(content: string): number[] {
  const ports: number[] = [];
  const lines = boundedText(content, MAX_DOCKERFILE_BYTES).split(/\r?\n/);

  for (const line of lines) {
    const match = /^\s*EXPOSE\s+(.+)$/i.exec(line);
    if (!match) continue;

    for (const token of match[1].trim().split(/\s+/)) {
      const portMatch = /^([0-9]{1,5})(?:\/(?:tcp|udp))?$/i.exec(token);
      if (portMatch) {
        const port = Number(portMatch[1]);
        if (isValidPort(port)) {
          ports.push(port);
        }
      }
    }
  }

  return Array.from(new Set(ports));
}

function extractDockerfileEnvArgPort(content: string): number | null {
  const lines = boundedText(content, MAX_DOCKERFILE_BYTES).split(/\r?\n/);

  for (const line of lines) {
    const match = /^\s*(?:ENV|ARG)\s+PORT[=\s]+([0-9]{1,5})\b/i.exec(line);
    if (match) {
      const port = Number(match[1]);
      if (isValidPort(port)) {
        return port;
      }
    }
  }

  return null;
}

/** Only a CMD/ENTRYPOINT line's own text — never executed, never shell-parsed. */
function extractDockerfileCommandPort(content: string): number | null {
  const lines = boundedText(content, MAX_DOCKERFILE_BYTES).split(/\r?\n/);

  for (const line of lines) {
    if (!/^\s*(CMD|ENTRYPOINT)\b/i.test(line)) continue;

    // Allows JSON-array CMD/ENTRYPOINT form (e.g. CMD ["node", "server.js",
    // "--port", "9090"]) as well as shell form (--port 9090) — the flag and
    // the number may be separated by quotes/commas/spaces/equals, never by
    // more than a few non-digit characters, so this can't accidentally
    // bridge across unrelated later tokens on a long line.
    const flagMatch = /(?:--port|-p)[^0-9]{1,6}([0-9]{1,5})\b/i.exec(line);
    if (flagMatch) {
      const port = Number(flagMatch[1]);
      if (isValidPort(port)) return port;
    }

    const envPrefixMatch = /\bPORT=([0-9]{1,5})\b/.exec(line);
    if (envPrefixMatch) {
      const port = Number(envPrefixMatch[1]);
      if (isValidPort(port)) return port;
    }
  }

  return null;
}

// ============================================================
// Port detection — package.json scripts
// ============================================================

const SCRIPT_PORT_PATTERNS = [/--port[=\s]+([0-9]{1,5})\b/i, /-p\s+([0-9]{1,5})\b/i, /-l\s+([0-9]{1,5})\b/i];

const PORT_SCRIPT_KEYS = ["start", "dev", "serve", "preview"] as const;

function extractScriptPort(scriptValue: string): number | null {
  for (const pattern of SCRIPT_PORT_PATTERNS) {
    const match = pattern.exec(scriptValue);
    if (match) {
      const port = Number(match[1]);
      if (isValidPort(port)) return port;
    }
  }
  return null;
}

function detectPackageScriptPort(raw: string): { port: number | null; evidence: string[]; conflict: boolean } {
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
    const evidence: string[] = [];
    const found = new Set<number>();

    for (const key of PORT_SCRIPT_KEYS) {
      const value = scripts[key];
      if (typeof value === "string") {
        const port = extractScriptPort(value);
        if (port !== null) {
          found.add(port);
          evidence.push(`"${key}" script specifies port ${port}`);
        }
      }
    }

    if (found.size === 1) {
      return { port: Array.from(found)[0], evidence, conflict: false };
    }
    if (found.size > 1) {
      return { port: null, evidence, conflict: true };
    }
    return { port: null, evidence: [], conflict: false };
  } catch {
    return { port: null, evidence: [], conflict: false };
  }
}

// ============================================================
// Port detection — source-code literal listen calls
// ============================================================

const SOURCE_LISTEN_PATTERNS = [
  /\.listen\(\s*([0-9]{1,5})\s*[,)]/,
  /\bconst\s+PORT\s*=\s*([0-9]{1,5})\b/,
  /\blet\s+PORT\s*=\s*([0-9]{1,5})\b/,
  /process\.env\.PORT\s*\|\|\s*([0-9]{1,5})\b/,
  /process\.env\.PORT\s*\?\?\s*([0-9]{1,5})\b/
];

function extractSourceCodePort(content: string): number | null {
  const bounded = boundedText(content, MAX_SOURCE_FILE_BYTES);
  for (const pattern of SOURCE_LISTEN_PATTERNS) {
    const match = pattern.exec(bounded);
    if (match) {
      const port = Number(match[1]);
      if (isValidPort(port)) return port;
    }
  }
  return null;
}

// ============================================================
// Port detection — framework/platform fallbacks
// ============================================================

function detectFrameworkDefaultPort(packageJsonRaw: string | null): { port: number; framework: string } | null {
  if (!packageJsonRaw) return null;

  try {
    const parsed = JSON.parse(packageJsonRaw) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };

    if ("next" in deps) return { port: 3000, framework: "Next.js" };
    if ("nuxt" in deps || "nuxt3" in deps) return { port: 3000, framework: "Nuxt" };
    if ("vite" in deps) return { port: 5173, framework: "Vite" };
    return null;
  } catch {
    return null;
  }
}

export interface PortDetectionInput {
  recommendedStrategy: BuildStrategy;
  dockerfileContent: string | null;
  packageJsonRaw: string | null;
  /** file path -> content, already fetched/read by the caller, bounded to PORT_SOURCE_CANDIDATE_FILES. */
  sourceFileContents: Record<string, string>;
}

/**
 * Combines every detection source under one clear precedence, per file:
 * (1) Dockerfile EXPOSE, (2) Dockerfile ENV/ARG/command port,
 * (3) package.json script port, (4) literal source-code listen port,
 * (5) platform-controlled strategy default, (6) framework low-confidence
 * suggestion, (7) nothing. Whenever two candidates at the same
 * precedence level disagree, this never guesses — it reports both and
 * requires manual selection instead.
 */
export function detectPort(input: PortDetectionInput): PortDetectionResult {
  if (input.dockerfileContent) {
    const exposedPorts = extractDockerfileExposePorts(input.dockerfileContent);

    if (exposedPorts.length === 1) {
      return {
        detectedPort: exposedPorts[0],
        source: "dockerfile-expose",
        confidence: "high",
        evidence: [`Dockerfile EXPOSE ${exposedPorts[0]}`],
        warnings: []
      };
    }
    if (exposedPorts.length > 1) {
      return {
        detectedPort: null,
        source: "dockerfile-expose",
        confidence: "none",
        evidence: exposedPorts.map((port) => `Dockerfile EXPOSE ${port}`),
        warnings: [`Multiple possible ports were detected: ${exposedPorts.join(" and ")}.`]
      };
    }

    const envPort = extractDockerfileEnvArgPort(input.dockerfileContent);
    const cmdPort = extractDockerfileCommandPort(input.dockerfileContent);

    if (envPort !== null && cmdPort !== null && envPort !== cmdPort) {
      return {
        detectedPort: null,
        source: "dockerfile-env",
        confidence: "none",
        evidence: [`Dockerfile ENV/ARG PORT=${envPort}`, `Dockerfile command references port ${cmdPort}`],
        warnings: [`Multiple possible ports were detected: ${envPort} and ${cmdPort}.`]
      };
    }

    const dockerfilePort = envPort ?? cmdPort;
    if (dockerfilePort !== null) {
      return {
        detectedPort: dockerfilePort,
        source: "dockerfile-env",
        confidence: "high",
        evidence: [
          envPort !== null
            ? `Dockerfile sets ENV/ARG PORT=${dockerfilePort}`
            : `Dockerfile command line references port ${dockerfilePort}`
        ],
        warnings: []
      };
    }
  }

  if (input.packageJsonRaw) {
    const scriptResult = detectPackageScriptPort(input.packageJsonRaw);

    if (scriptResult.port !== null) {
      return {
        detectedPort: scriptResult.port,
        source: "package-script",
        confidence: "high",
        evidence: scriptResult.evidence,
        warnings: []
      };
    }
    if (scriptResult.conflict) {
      return {
        detectedPort: null,
        source: "package-script",
        confidence: "none",
        evidence: scriptResult.evidence,
        warnings: ["Multiple possible ports were detected across package.json scripts."]
      };
    }
  }

  const sourcePorts = new Set<number>();
  const sourceEvidence: string[] = [];
  for (const [file, content] of Object.entries(input.sourceFileContents)) {
    const port = extractSourceCodePort(content);
    if (port !== null) {
      sourcePorts.add(port);
      sourceEvidence.push(`Literal server listen port ${port} found in ${file}`);
    }
  }

  if (sourcePorts.size === 1) {
    return {
      detectedPort: Array.from(sourcePorts)[0],
      source: "source-code",
      confidence: "high",
      evidence: sourceEvidence,
      warnings: [
        "Port was inferred from application source code rather than an explicit Dockerfile setting — confirm it before deploying."
      ]
    };
  }
  if (sourcePorts.size > 1) {
    return {
      detectedPort: null,
      source: "source-code",
      confidence: "none",
      evidence: sourceEvidence,
      warnings: [`Multiple possible ports were detected: ${Array.from(sourcePorts).join(" and ")}.`]
    };
  }

  if (input.recommendedStrategy === "static") {
    return {
      detectedPort: 80,
      source: "platform-default",
      confidence: "high",
      evidence: ["Static-site deployments are served by the platform-managed Nginx image on port 80."],
      warnings: []
    };
  }

  const framework = detectFrameworkDefaultPort(input.packageJsonRaw);
  if (framework) {
    return {
      detectedPort: framework.port,
      source: "framework-default",
      confidence: "low",
      evidence: [`${framework.framework} projects conventionally listen on port ${framework.port}.`],
      warnings: ["Suggested port, not confirmed — verify or override before deploying."]
    };
  }

  return {
    detectedPort: null,
    source: "none",
    confidence: "none",
    evidence: [],
    warnings: ["No listening port could be detected. Enter the container port manually."]
  };
}

// ============================================================
// Project-type detection (unchanged logic, now also attaches portDetection)
// ============================================================

interface DetectProjectTypeExtra {
  dockerfileContent?: string | null;
  sourceFileContents?: Record<string, string>;
}

function detectProjectTypeCore(
  presentFiles: Set<string>,
  packageJsonRaw: string | null
): Omit<InspectionDetection, "portDetection"> {
  const warnings: string[] = [];
  const present = Array.from(presentFiles).sort();

  if (presentFiles.has("Dockerfile")) {
    return {
      detectedProjectType: "dockerfile",
      recommendedStrategy: "dockerfile",
      presentFiles: present,
      packageJson: null,
      warnings,
      supported: true,
      unsupportedReason: null
    };
  }

  if (presentFiles.has("docker-compose.yml") || presentFiles.has("docker-compose.yaml")) {
    return {
      detectedProjectType: "docker-compose",
      recommendedStrategy: "unsupported",
      presentFiles: present,
      packageJson: null,
      warnings: ["Docker Compose projects are not supported for automatic deployment yet."],
      supported: false,
      unsupportedReason:
        "This repository defines a Docker Compose stack. Compose deployment is out of scope for this phase — add a single Dockerfile to deploy it here."
    };
  }

  if (presentFiles.has("package.json")) {
    const packageManager = pickPackageManager(presentFiles);
    const scripts = packageJsonRaw
      ? parsePackageJsonScripts(packageJsonRaw)
      : { hasBuildScript: false, hasStartScript: false };

    if (!scripts.hasStartScript) {
      warnings.push('No "start" script was found in package.json — a container port and start command may need to be configured manually.');
    }
    if (!scripts.hasBuildScript) {
      warnings.push('No "build" script was found in package.json — the build step will be skipped.');
    }

    return {
      detectedProjectType: "nodejs",
      recommendedStrategy: "nodejs",
      presentFiles: present,
      packageJson: { packageManager, ...scripts },
      warnings,
      supported: true,
      unsupportedReason: null
    };
  }

  if (presentFiles.has("index.html")) {
    return {
      detectedProjectType: "static",
      recommendedStrategy: "static",
      presentFiles: present,
      packageJson: null,
      warnings,
      supported: true,
      unsupportedReason: null
    };
  }

  const unsupportedMarkers: Array<{ files: string[]; type: DetectedProjectType; label: string }> = [
    { files: ["requirements.txt", "pyproject.toml", "Pipfile", "poetry.lock"], type: "python", label: "Python" },
    { files: ["go.mod"], type: "go", label: "Go" },
    { files: ["Cargo.toml"], type: "rust", label: "Rust" },
    { files: ["composer.json"], type: "php", label: "PHP" },
    { files: ["Gemfile"], type: "ruby", label: "Ruby" },
    { files: ["pom.xml", "build.gradle", "build.gradle.kts"], type: "java", label: "Java" }
  ];

  for (const marker of unsupportedMarkers) {
    if (marker.files.some((file) => presentFiles.has(file))) {
      return {
        detectedProjectType: marker.type,
        recommendedStrategy: "unsupported",
        presentFiles: present,
        packageJson: null,
        warnings: [`${marker.label} projects are not yet supported for automatic builds.`],
        supported: false,
        unsupportedReason: `This looks like a ${marker.label} project. Add a Dockerfile to deploy it here — native ${marker.label} builds aren't supported yet.`
      };
    }
  }

  return {
    detectedProjectType: "unknown",
    recommendedStrategy: "unsupported",
    presentFiles: present,
    packageJson: null,
    warnings: ["Could not identify a supported project type."],
    supported: false,
    unsupportedReason: "Add a Dockerfile to deploy this repository — no recognized project files were found."
  };
}

/**
 * The one place that turns "which files are present" (+ optionally
 * package.json's own scripts, a Dockerfile's own text, and a small
 * bounded set of entry-point files' text) into a project type, a
 * recommended build strategy, a port suggestion, and user-facing
 * warnings. Pure and synchronous — callers gather everything from
 * wherever is appropriate (a live GitHub API probe before cloning, or a
 * real directory listing right after cloning) and this function never
 * itself touches the network or the filesystem.
 */
export function detectProjectType(
  presentFiles: Set<string>,
  packageJsonRaw: string | null,
  extra?: DetectProjectTypeExtra
): InspectionDetection {
  const core = detectProjectTypeCore(presentFiles, packageJsonRaw);
  const portDetection = detectPort({
    recommendedStrategy: core.recommendedStrategy,
    dockerfileContent: extra?.dockerfileContent ?? null,
    packageJsonRaw,
    sourceFileContents: extra?.sourceFileContents ?? {}
  });

  return { ...core, portDetection };
}

export interface RemoteInspectionOptions {
  token: string;
  repositoryOwner: string;
  repositoryName: string;
  ref: string;
  subdirectory: string;
}

/**
 * Probes a repository over the GitHub API — one bounded existence check
 * per known manifest file plus per port-detection candidate file, then
 * one bounded content read for package.json (always, if present),
 * Dockerfile (always, if present), and each present port-detection
 * candidate file (bounded to this fixed, short list — never a
 * recursive scan). Never clones or downloads bulk source. Used for the
 * "Inspect repository" action before a deploy.
 */
export async function inspectRepositoryRemote(
  client: SourceProviderClient,
  options: RemoteInspectionOptions
): Promise<InspectionDetection> {
  const present = new Set<string>();
  const presentSourceCandidates = new Set<string>();

  await Promise.all([
    ...INSPECTABLE_FILES.map(async (file) => {
      const exists = await client.pathExists(
        options.token,
        options.repositoryOwner,
        options.repositoryName,
        options.ref,
        joinRepoPath(options.subdirectory, file)
      );
      if (exists) {
        present.add(file);
      }
    }),
    ...PORT_SOURCE_CANDIDATE_FILES.map(async (file) => {
      const exists = await client.pathExists(
        options.token,
        options.repositoryOwner,
        options.repositoryName,
        options.ref,
        joinRepoPath(options.subdirectory, file)
      );
      if (exists) {
        presentSourceCandidates.add(file);
      }
    })
  ]);

  let packageJsonRaw: string | null = null;
  if (present.has("package.json")) {
    try {
      packageJsonRaw = await client.getFileContents(
        options.token,
        options.repositoryOwner,
        options.repositoryName,
        options.ref,
        joinRepoPath(options.subdirectory, "package.json")
      );
    } catch {
      packageJsonRaw = null;
    }
  }

  let dockerfileContent: string | null = null;
  if (present.has("Dockerfile")) {
    try {
      dockerfileContent = await client.getFileContents(
        options.token,
        options.repositoryOwner,
        options.repositoryName,
        options.ref,
        joinRepoPath(options.subdirectory, "Dockerfile")
      );
    } catch {
      dockerfileContent = null;
    }
  }

  const sourceFileContents: Record<string, string> = {};
  await Promise.all(
    Array.from(presentSourceCandidates).map(async (file) => {
      try {
        const content = await client.getFileContents(
          options.token,
          options.repositoryOwner,
          options.repositoryName,
          options.ref,
          joinRepoPath(options.subdirectory, file)
        );
        if (content) {
          sourceFileContents[file] = content;
        }
      } catch {
        // Best-effort only — a single unreadable candidate file must
        // never fail the whole inspection.
      }
    })
  );

  return detectProjectType(present, packageJsonRaw, { dockerfileContent, sourceFileContents });
}

/**
 * Inspects an already-cloned checkout directly on disk — the
 * authoritative check run during an actual deployment, immediately
 * after cloning, so a build never proceeds on the basis of a stale
 * remote inspection result.
 */
export function inspectCheckoutDirectory(checkoutDir: string, subdirectory: string): InspectionDetection {
  const targetDir = resolveWithinRoot(checkoutDir, subdirectory);

  let entries: string[];
  try {
    entries = readdirSync(targetDir);
  } catch {
    return detectProjectType(new Set(), null);
  }

  const entrySet = new Set(entries);
  const present = new Set<string>(INSPECTABLE_FILES.filter((file) => entrySet.has(file)));

  let packageJsonRaw: string | null = null;
  if (present.has("package.json")) {
    try {
      packageJsonRaw = readFileSync(join(targetDir, "package.json"), "utf8");
    } catch {
      packageJsonRaw = null;
    }
  }

  let dockerfileContent: string | null = null;
  if (present.has("Dockerfile")) {
    try {
      dockerfileContent = readFileSync(join(targetDir, "Dockerfile"), "utf8");
    } catch {
      dockerfileContent = null;
    }
  }

  const sourceFileContents: Record<string, string> = {};
  for (const file of PORT_SOURCE_CANDIDATE_FILES) {
    // Each candidate may include a subdirectory segment (e.g.
    // "src/server.js") — resolveWithinRoot still guards the read against
    // escaping targetDir via a traversal segment.
    try {
      const filePath = resolveWithinRoot(targetDir, file);
      sourceFileContents[file] = readFileSync(filePath, "utf8");
    } catch {
      // Most candidates won't exist — that's expected, not an error.
    }
  }

  return detectProjectType(present, packageJsonRaw, { dockerfileContent, sourceFileContents });
}
