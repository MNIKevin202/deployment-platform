import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  detectProjectType,
  inspectCheckoutDirectory,
  inspectRepositoryRemote
} from "../services/repository-inspection-service.js";
import type { SourceProviderClient } from "../services/source-provider.js";

describe("detectProjectType", () => {
  test("detects a Dockerfile project first, even alongside other markers", () => {
    const result = detectProjectType(new Set(["Dockerfile", "package.json"]), null);
    assert.equal(result.detectedProjectType, "dockerfile");
    assert.equal(result.recommendedStrategy, "dockerfile");
    assert.equal(result.supported, true);
  });

  test("detects a Docker Compose project as unsupported with an explanation", () => {
    const result = detectProjectType(new Set(["docker-compose.yml"]), null);
    assert.equal(result.detectedProjectType, "docker-compose");
    assert.equal(result.recommendedStrategy, "unsupported");
    assert.equal(result.supported, false);
    assert.ok(result.unsupportedReason);
  });

  test("detects a Node.js project and picks npm by default", () => {
    const packageJson = JSON.stringify({ scripts: { start: "node index.js", build: "webpack" } });
    const result = detectProjectType(new Set(["package.json"]), packageJson);
    assert.equal(result.detectedProjectType, "nodejs");
    assert.equal(result.recommendedStrategy, "nodejs");
    assert.equal(result.packageJson?.packageManager, "npm");
    assert.equal(result.packageJson?.hasStartScript, true);
    assert.equal(result.packageJson?.hasBuildScript, true);
    assert.equal(result.warnings.length, 0);
  });

  test("prefers pnpm when pnpm-lock.yaml is present", () => {
    const packageJson = JSON.stringify({ scripts: { start: "node index.js" } });
    const result = detectProjectType(new Set(["package.json", "pnpm-lock.yaml"]), packageJson);
    assert.equal(result.packageJson?.packageManager, "pnpm");
  });

  test("warns when package.json has no start or build script", () => {
    const packageJson = JSON.stringify({ scripts: {} });
    const result = detectProjectType(new Set(["package.json"]), packageJson);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.some((w) => w.includes("start")));
    assert.ok(result.warnings.some((w) => w.includes("build")));
  });

  test("detects a static site when only index.html is present", () => {
    const result = detectProjectType(new Set(["index.html"]), null);
    assert.equal(result.detectedProjectType, "static");
    assert.equal(result.recommendedStrategy, "static");
    assert.equal(result.supported, true);
  });

  test("detects a Python project as unsupported", () => {
    const result = detectProjectType(new Set(["requirements.txt"]), null);
    assert.equal(result.detectedProjectType, "python");
    assert.equal(result.supported, false);
  });

  test("falls back to unknown when nothing recognizable is present", () => {
    const result = detectProjectType(new Set(["README.md"]), null);
    assert.equal(result.detectedProjectType, "unknown");
    assert.equal(result.supported, false);
  });

  test("gracefully handles malformed package.json content", () => {
    const result = detectProjectType(new Set(["package.json"]), "{ not valid json");
    assert.equal(result.detectedProjectType, "nodejs");
    assert.equal(result.packageJson?.hasStartScript, false);
    assert.equal(result.packageJson?.hasBuildScript, false);
  });
});

describe("inspectCheckoutDirectory", () => {
  let checkoutDir: string;

  beforeEach(() => {
    checkoutDir = mkdtempSync(join(tmpdir(), "inspect-checkout-test-"));
  });

  afterEach(() => {
    rmSync(checkoutDir, { recursive: true, force: true });
  });

  test("reads package.json content from disk to detect scripts", () => {
    writeFileSync(
      join(checkoutDir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js" } })
    );

    const result = inspectCheckoutDirectory(checkoutDir, ".");
    assert.equal(result.detectedProjectType, "nodejs");
    assert.equal(result.packageJson?.hasStartScript, true);
  });

  test("inspects a configured subdirectory rather than the checkout root", () => {
    mkdirSync(join(checkoutDir, "app"));
    writeFileSync(join(checkoutDir, "app", "Dockerfile"), "FROM scratch\n");

    const rootResult = inspectCheckoutDirectory(checkoutDir, ".");
    assert.equal(rootResult.detectedProjectType, "unknown");

    const subdirResult = inspectCheckoutDirectory(checkoutDir, "app");
    assert.equal(subdirResult.detectedProjectType, "dockerfile");
  });

  test("rejects a subdirectory that attempts to escape the checkout", () => {
    assert.throws(() => inspectCheckoutDirectory(checkoutDir, "../../etc"));
  });

  test("returns unknown (not a throw) for a missing subdirectory", () => {
    const result = inspectCheckoutDirectory(checkoutDir, "does-not-exist");
    assert.equal(result.detectedProjectType, "unknown");
  });
});

describe("inspectRepositoryRemote", () => {
  function makeFakeClient(present: Set<string>, packageJsonContent: string | null): SourceProviderClient {
    return {
      provider: "github",
      async validateCredential() {
        throw new Error("not used in this test");
      },
      async listRepositories() {
        throw new Error("not used in this test");
      },
      async getRepository() {
        throw new Error("not used in this test");
      },
      async listBranches() {
        throw new Error("not used in this test");
      },
      async listCommits() {
        throw new Error("not used in this test");
      },
      async resolveBranchCommit() {
        throw new Error("not used in this test");
      },
      async pathExists(_token, _owner, _repo, _ref, path) {
        return present.has(path);
      },
      async getFileContents(_token, _owner, _repo, _ref, path) {
        if (path === "package.json" && packageJsonContent !== null) {
          return packageJsonContent;
        }
        throw new Error("file not found");
      }
    };
  }

  test("probes every known manifest file and aggregates the results", async () => {
    const client = makeFakeClient(
      new Set(["package.json", "package-lock.json"]),
      JSON.stringify({ scripts: { start: "node index.js" } })
    );

    const result = await inspectRepositoryRemote(client, {
      token: "test-token",
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      ref: "main",
      subdirectory: "."
    });

    assert.equal(result.detectedProjectType, "nodejs");
    assert.deepEqual(result.presentFiles.sort(), ["package-lock.json", "package.json"]);
  });

  test("scopes probes to the configured subdirectory", async () => {
    const client = makeFakeClient(new Set(["services/api/Dockerfile"]), null);

    const result = await inspectRepositoryRemote(client, {
      token: "test-token",
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      ref: "main",
      subdirectory: "services/api"
    });

    assert.equal(result.detectedProjectType, "dockerfile");
  });

  test("never throws just because package.json content can't be read", async () => {
    const client = makeFakeClient(new Set(["package.json"]), null);

    const result = await inspectRepositoryRemote(client, {
      token: "test-token",
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      ref: "main",
      subdirectory: "."
    });

    assert.equal(result.detectedProjectType, "nodejs");
    assert.equal(result.packageJson?.hasStartScript, false);
  });
});
