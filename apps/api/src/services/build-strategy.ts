import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildStrategy } from "../app-source-database.js";
import { resolveWithinRoot } from "./path-security.js";
import type { PackageManager } from "./repository-inspection-service.js";

export class BuildPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildPlanError";
  }
}

export interface BuildPlan {
  /** Absolute path to the Dockerfile `docker build` should use. */
  dockerfilePath: string;
  /** Absolute path to the build context directory. */
  buildContextPath: string;
}

const INSTALL_COMMANDS: Record<PackageManager, (hasLockfile: boolean) => string> = {
  npm: (hasLockfile) => (hasLockfile ? "npm ci" : "npm install"),
  pnpm: () => "pnpm install --frozen-lockfile",
  yarn: () => "yarn install --frozen-lockfile",
  bun: () => "bun install --frozen-lockfile"
};

const BUILD_COMMANDS: Record<PackageManager, string> = {
  npm: "npm run build",
  pnpm: "pnpm run build",
  yarn: "yarn build",
  bun: "bun run build"
};

const START_COMMANDS: Record<PackageManager, string[]> = {
  npm: ["npm", "start"],
  pnpm: ["pnpm", "start"],
  yarn: ["yarn", "start"],
  bun: ["bun", "start"]
};

export interface NodejsPlanInput {
  packageManager: PackageManager;
  hasLockfile: boolean;
  hasBuildScript: boolean;
  hasStartScript: boolean;
  containerPort: number;
}

/**
 * Generates a controlled Dockerfile for a Node.js project — every
 * command comes from the fixed lookup tables above, keyed only by which
 * package manager was *detected* (never by anything the operator typed
 * freely). A missing start script is a hard failure here, not a
 * guessed fallback command: this phase does not run a command nobody
 * can point to in the source repository.
 */
export function generateNodejsDockerfile(input: NodejsPlanInput): string {
  if (!input.hasStartScript) {
    throw new BuildPlanError(
      'No "start" script was found in package.json. Add one to the repository before deploying it as a Node.js application.'
    );
  }

  const install = INSTALL_COMMANDS[input.packageManager](input.hasLockfile);
  const startCommand = START_COMMANDS[input.packageManager];
  const startCommandJson = JSON.stringify(startCommand);

  const lines = [
    "FROM node:24-alpine",
    "WORKDIR /app",
    "COPY package.json ./",
    "COPY package-lock.json* npm-shrinkwrap.json* pnpm-lock.yaml* yarn.lock* bun.lock* bun.lockb* ./",
    `RUN ${install}`,
    "COPY . .",
    input.hasBuildScript ? `RUN ${BUILD_COMMANDS[input.packageManager]}` : null,
    `EXPOSE ${input.containerPort}`,
    `CMD ${startCommandJson}`
  ].filter((line): line is string => line !== null);

  return `${lines.join("\n")}\n`;
}

/** Generates a controlled static-site Dockerfile: serve the checkout's contents with nginx. */
export function generateStaticDockerfile(): string {
  return ["FROM nginx:alpine", "COPY . /usr/share/nginx/html", "EXPOSE 80", ""].join("\n");
}

export interface BuildPlanInput {
  strategy: BuildStrategy;
  checkoutDir: string;
  subdirectory: string;
  dockerfilePath: string;
  buildContext: string;
  nodejs?: NodejsPlanInput;
}

/**
 * Turns a build strategy into a concrete, on-disk Dockerfile + build
 * context that `docker build` can use. For "dockerfile", the repository
 * already provides everything — this only resolves and validates the
 * configured paths stay inside the checkout. For "nodejs"/"static", a
 * Dockerfile is generated and written into the (subdirectory-scoped)
 * build context; nothing here ever executes a shell command against the
 * checkout beyond what `docker build` itself later runs inside the
 * resulting image.
 */
export function prepareBuildPlan(input: BuildPlanInput): BuildPlan {
  if (input.strategy === "unsupported") {
    throw new BuildPlanError("This repository's detected project type is not supported for automatic deployment yet.");
  }

  if (input.strategy === "dockerfile") {
    return {
      dockerfilePath: resolveWithinRoot(input.checkoutDir, input.dockerfilePath),
      buildContextPath: resolveWithinRoot(input.checkoutDir, input.buildContext)
    };
  }

  const buildContextPath = resolveWithinRoot(input.checkoutDir, input.subdirectory);
  const generatedDockerfilePath = join(buildContextPath, ".platform-generated.Dockerfile");

  let content: string;
  if (input.strategy === "nodejs") {
    if (!input.nodejs) {
      throw new BuildPlanError("Node.js build configuration is missing");
    }
    content = generateNodejsDockerfile(input.nodejs);
  } else {
    content = generateStaticDockerfile();
  }

  writeFileSync(generatedDockerfilePath, content, "utf8");

  return { dockerfilePath: generatedDockerfilePath, buildContextPath };
}
