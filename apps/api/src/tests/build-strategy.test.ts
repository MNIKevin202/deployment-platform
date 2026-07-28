import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  BuildPlanError,
  generateNodejsDockerfile,
  generateStaticDockerfile,
  prepareBuildPlan
} from "../services/build-strategy.js";
import { PathSecurityError } from "../services/path-security.js";

describe("generateNodejsDockerfile", () => {
  test("throws when there is no start script — never guesses a command", () => {
    assert.throws(
      () =>
        generateNodejsDockerfile({
          packageManager: "npm",
          hasLockfile: true,
          hasBuildScript: false,
          hasStartScript: false,
          containerPort: 3000
        }),
      BuildPlanError
    );
  });

  test("uses npm ci when a lockfile is present, npm install otherwise", () => {
    const withLockfile = generateNodejsDockerfile({
      packageManager: "npm",
      hasLockfile: true,
      hasBuildScript: false,
      hasStartScript: true,
      containerPort: 3000
    });
    assert.match(withLockfile, /RUN npm ci/);

    const withoutLockfile = generateNodejsDockerfile({
      packageManager: "npm",
      hasLockfile: false,
      hasBuildScript: false,
      hasStartScript: true,
      containerPort: 3000
    });
    assert.match(withoutLockfile, /RUN npm install/);
  });

  test("includes a build step only when a build script exists", () => {
    const withBuild = generateNodejsDockerfile({
      packageManager: "npm",
      hasLockfile: true,
      hasBuildScript: true,
      hasStartScript: true,
      containerPort: 3000
    });
    assert.match(withBuild, /RUN npm run build/);

    const withoutBuild = generateNodejsDockerfile({
      packageManager: "npm",
      hasLockfile: true,
      hasBuildScript: false,
      hasStartScript: true,
      containerPort: 3000
    });
    assert.doesNotMatch(withoutBuild, /RUN npm run build/);
  });

  test("uses the package manager's own start command, never a freely-typed one", () => {
    const dockerfile = generateNodejsDockerfile({
      packageManager: "yarn",
      hasLockfile: true,
      hasBuildScript: false,
      hasStartScript: true,
      containerPort: 8080
    });
    assert.match(dockerfile, /CMD \["yarn","start"\]/);
    assert.match(dockerfile, /EXPOSE 8080/);
  });
});

describe("generateStaticDockerfile", () => {
  test("serves the checkout with nginx on port 80", () => {
    const dockerfile = generateStaticDockerfile();
    assert.match(dockerfile, /FROM nginx:alpine/);
    assert.match(dockerfile, /EXPOSE 80/);
  });
});

describe("prepareBuildPlan", () => {
  let checkoutDir: string;

  beforeEach(() => {
    checkoutDir = mkdtempSync(join(tmpdir(), "build-plan-test-"));
    writeFileSync(join(checkoutDir, "Dockerfile"), "FROM scratch\n");
  });

  afterEach(() => {
    rmSync(checkoutDir, { recursive: true, force: true });
  });

  test("resolves the configured Dockerfile and build context for the dockerfile strategy", () => {
    const plan = prepareBuildPlan({
      strategy: "dockerfile",
      checkoutDir,
      subdirectory: ".",
      dockerfilePath: "Dockerfile",
      buildContext: "."
    });

    assert.equal(plan.dockerfilePath, join(checkoutDir, "Dockerfile"));
    assert.equal(plan.buildContextPath, checkoutDir);
  });

  test("rejects a Dockerfile path that escapes the checkout root", () => {
    assert.throws(
      () =>
        prepareBuildPlan({
          strategy: "dockerfile",
          checkoutDir,
          subdirectory: ".",
          dockerfilePath: "../../etc/passwd",
          buildContext: "."
        }),
      PathSecurityError
    );
  });

  test("generates and writes a Node.js Dockerfile into the build context", () => {
    writeFileSync(join(checkoutDir, "package.json"), JSON.stringify({ scripts: { start: "node index.js" } }));

    const plan = prepareBuildPlan({
      strategy: "nodejs",
      checkoutDir,
      subdirectory: ".",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      nodejs: {
        packageManager: "npm",
        hasLockfile: false,
        hasBuildScript: false,
        hasStartScript: true,
        containerPort: 3000
      }
    });

    const content = readFileSync(plan.dockerfilePath, "utf8");
    assert.match(content, /FROM node:24-alpine/);
    assert.equal(plan.buildContextPath, checkoutDir);
  });

  test("build context '.' resolves to the configured subdirectory, not the repository root (requirement 3/4)", () => {
    mkdirSync(join(checkoutDir, "tools", "roadmap-studio"), { recursive: true });
    writeFileSync(join(checkoutDir, "tools", "roadmap-studio", "Dockerfile"), "FROM scratch\n");

    const plan = prepareBuildPlan({
      strategy: "dockerfile",
      checkoutDir,
      subdirectory: "tools/roadmap-studio",
      dockerfilePath: "Dockerfile",
      buildContext: "."
    });

    assert.equal(plan.dockerfilePath, join(checkoutDir, "tools", "roadmap-studio", "Dockerfile"));
    assert.equal(plan.buildContextPath, join(checkoutDir, "tools", "roadmap-studio"));
  });

  test("regression fixture: roadmapstudio-web (subdirectory tools/roadmap-studio, dockerfilePath Dockerfile, buildContext .)", () => {
        mkdirSync(join(checkoutDir, "tools", "roadmap-studio"), { recursive: true });
    writeFileSync(join(checkoutDir, "tools", "roadmap-studio", "Dockerfile"), "FROM scratch\n");

    const plan = prepareBuildPlan({
      strategy: "dockerfile",
      checkoutDir,
      subdirectory: "tools/roadmap-studio",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      branch: "main"
    });

    assert.equal(plan.dockerfilePath, join(checkoutDir, "tools", "roadmap-studio", "Dockerfile"));
    assert.equal(plan.buildContextPath, join(checkoutDir, "tools", "roadmap-studio"));
  });

  test("a nested Dockerfile path resolves relative to the subdirectory (requirement 4 in TESTS list)", () => {
        mkdirSync(join(checkoutDir, "tools", "roadmap-studio", "docker"), { recursive: true });
    writeFileSync(join(checkoutDir, "tools", "roadmap-studio", "docker", "Dockerfile.prod"), "FROM scratch\n");

    const plan = prepareBuildPlan({
      strategy: "dockerfile",
      checkoutDir,
      subdirectory: "tools/roadmap-studio",
      dockerfilePath: "docker/Dockerfile.prod",
      buildContext: "."
    });

    assert.equal(
      plan.dockerfilePath,
      join(checkoutDir, "tools", "roadmap-studio", "docker", "Dockerfile.prod")
    );
  });

  test("a missing Dockerfile inside the subdirectory fails with the EFFECTIVE path shown (requirement 8), before any build runs", () => {
        mkdirSync(join(checkoutDir, "tools", "roadmap-studio"), { recursive: true });
    // Deliberately no Dockerfile written inside tools/roadmap-studio.

    assert.throws(
      () =>
        prepareBuildPlan({
          strategy: "dockerfile",
          checkoutDir,
          subdirectory: "tools/roadmap-studio",
          dockerfilePath: "Dockerfile",
          buildContext: ".",
          branch: "main"
        }),
      (error: unknown) =>
        error instanceof BuildPlanError &&
        /Dockerfile not found at "tools\/roadmap-studio\/Dockerfile" on branch "main"/.test(error.message)
    );
  });

  test("refuses to build an unsupported strategy", () => {
    assert.throws(
      () =>
        prepareBuildPlan({
          strategy: "unsupported",
          checkoutDir,
          subdirectory: ".",
          dockerfilePath: "Dockerfile",
          buildContext: "."
        }),
      BuildPlanError
    );
  });
});
