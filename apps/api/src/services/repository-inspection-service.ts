import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BuildStrategy } from "../app-source-database.js";
import { resolveWithinRoot } from "./path-security.js";
import type { SourceProviderClient } from "./source-provider.js";

/**
 * Every manifest/marker file this phase knows how to recognize.
 * Presence-only for most of these — content is only ever read for
 * `package.json` (to find build/start scripts and pick a package
 * manager), and even then only up to the bounded size enforced by
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

export interface InspectionDetection {
  detectedProjectType: DetectedProjectType;
  recommendedStrategy: BuildStrategy;
  presentFiles: string[];
  packageJson: PackageJsonSummary | null;
  warnings: string[];
  supported: boolean;
  unsupportedReason: string | null;
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

/**
 * The one place that turns "which files are present" (+ optionally
 * package.json's own scripts) into a project type, a recommended build
 * strategy, and user-facing warnings. Pure and synchronous — callers
 * gather `presentFiles`/`packageJsonRaw` from wherever is appropriate
 * (a live GitHub API probe before cloning, or a real directory listing
 * right after cloning) and this function never itself touches the
 * network or the filesystem.
 */
export function detectProjectType(
  presentFiles: Set<string>,
  packageJsonRaw: string | null
): InspectionDetection {
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

export interface RemoteInspectionOptions {
  token: string;
  repositoryOwner: string;
  repositoryName: string;
  ref: string;
  subdirectory: string;
}

function joinRepoPath(subdirectory: string, file: string): string {
  return subdirectory === "." ? file : `${subdirectory}/${file}`;
}

/**
 * Probes a repository over the GitHub API — one bounded existence check
 * per known manifest file, then (only for package.json, and only if
 * present) one bounded content read. Never clones or downloads bulk
 * source. Used for the "Inspect repository" action before a deploy.
 */
export async function inspectRepositoryRemote(
  client: SourceProviderClient,
  options: RemoteInspectionOptions
): Promise<InspectionDetection> {
  const present = new Set<string>();

  await Promise.all(
    INSPECTABLE_FILES.map(async (file) => {
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
    })
  );

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

  return detectProjectType(present, packageJsonRaw);
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

  return detectProjectType(present, packageJsonRaw);
}
