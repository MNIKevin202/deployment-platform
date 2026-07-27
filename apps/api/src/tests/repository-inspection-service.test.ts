import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  detectPort,
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

describe("detectPort", () => {
  test("prefers a single Dockerfile EXPOSE port with high confidence", () => {
    const result = detectPort({
      recommendedStrategy: "dockerfile",
      dockerfileContent: "FROM node:24-alpine\nEXPOSE 53123\nCMD [\"node\", \"server.js\"]\n",
      packageJsonRaw: null,
      sourceFileContents: {}
    });
    assert.equal(result.detectedPort, 53123);
    assert.equal(result.source, "dockerfile-expose");
    assert.equal(result.confidence, "high");
  });

  test("detects a Dockerfile ENV PORT setting when EXPOSE is absent", () => {
    const result = detectPort({
      recommendedStrategy: "dockerfile",
      dockerfileContent: "FROM node:24-alpine\nENV PORT=4000\nCMD [\"node\", \"server.js\"]\n",
      packageJsonRaw: null,
      sourceFileContents: {}
    });
    assert.equal(result.detectedPort, 4000);
    assert.equal(result.source, "dockerfile-env");
    assert.equal(result.confidence, "high");
  });

  test("detects a --port command-line flag in CMD when nothing else is present", () => {
    const result = detectPort({
      recommendedStrategy: "dockerfile",
      dockerfileContent: 'FROM node:24-alpine\nCMD ["node", "server.js", "--port", "9090"]\n',
      packageJsonRaw: null,
      sourceFileContents: {}
    });
    assert.equal(result.detectedPort, 9090);
    assert.equal(result.source, "dockerfile-env");
  });

  test("does not guess when multiple EXPOSE ports conflict", () => {
    const result = detectPort({
      recommendedStrategy: "dockerfile",
      dockerfileContent: "FROM node:24-alpine\nEXPOSE 3000\nEXPOSE 8080\n",
      packageJsonRaw: null,
      sourceFileContents: {}
    });
    assert.equal(result.detectedPort, null);
    assert.equal(result.confidence, "none");
    assert.ok(result.warnings.some((w) => w.includes("3000") && w.includes("8080")));
  });

  test("detects a port from a package.json start script", () => {
    const result = detectPort({
      recommendedStrategy: "nodejs",
      dockerfileContent: null,
      packageJsonRaw: JSON.stringify({ scripts: { start: "node server.js --port 3000" } }),
      sourceFileContents: {}
    });
    assert.equal(result.detectedPort, 3000);
    assert.equal(result.source, "package-script");
    assert.equal(result.confidence, "high");
  });

  test("detects a literal app.listen port from source code", () => {
    const result = detectPort({
      recommendedStrategy: "nodejs",
      dockerfileContent: null,
      packageJsonRaw: JSON.stringify({ scripts: {} }),
      sourceFileContents: { "server.js": "const app = express();\napp.listen(53123);\n" }
    });
    assert.equal(result.detectedPort, 53123);
    assert.equal(result.source, "source-code");
    assert.equal(result.confidence, "high");
  });

  test("detects process.env.PORT || literal fallback", () => {
    const result = detectPort({
      recommendedStrategy: "nodejs",
      dockerfileContent: null,
      packageJsonRaw: null,
      sourceFileContents: { "index.js": "const port = process.env.PORT || 4321;\n" }
    });
    assert.equal(result.detectedPort, 4321);
    assert.equal(result.source, "source-code");
  });

  test("detects process.env.PORT ?? literal fallback", () => {
    const result = detectPort({
      recommendedStrategy: "nodejs",
      dockerfileContent: null,
      packageJsonRaw: null,
      sourceFileContents: { "index.js": "const port = process.env.PORT ?? 4321;\n" }
    });
    assert.equal(result.detectedPort, 4321);
    assert.equal(result.source, "source-code");
  });

  test("does not guess when source files disagree on the port", () => {
    const result = detectPort({
      recommendedStrategy: "nodejs",
      dockerfileContent: null,
      packageJsonRaw: null,
      sourceFileContents: {
        "server.js": "app.listen(3000);",
        "index.js": "app.listen(8080);"
      }
    });
    assert.equal(result.detectedPort, null);
    assert.equal(result.confidence, "none");
  });

  test("suggests a framework default at low confidence only, never silently applied", () => {
    const result = detectPort({
      recommendedStrategy: "nodejs",
      dockerfileContent: null,
      packageJsonRaw: JSON.stringify({ dependencies: { vite: "^5.0.0" } }),
      sourceFileContents: {}
    });
    assert.equal(result.detectedPort, 5173);
    assert.equal(result.source, "framework-default");
    assert.equal(result.confidence, "low");
    assert.ok(result.warnings.some((w) => w.toLowerCase().includes("not confirmed")));
  });

  test("uses a high-confidence platform default of 80 for static deployments", () => {
    const result = detectPort({
      recommendedStrategy: "static",
      dockerfileContent: null,
      packageJsonRaw: null,
      sourceFileContents: {}
    });
    assert.equal(result.detectedPort, 80);
    assert.equal(result.source, "platform-default");
    assert.equal(result.confidence, "high");
  });

  test("reports no detection when nothing matches", () => {
    const result = detectPort({
      recommendedStrategy: "dockerfile",
      dockerfileContent: "FROM scratch\nCOPY . .\n",
      packageJsonRaw: null,
      sourceFileContents: {}
    });
    assert.equal(result.detectedPort, null);
    assert.equal(result.source, "none");
    assert.equal(result.confidence, "none");
  });

  test("rejects an out-of-range EXPOSE port rather than treating it as valid", () => {
    const result = detectPort({
      recommendedStrategy: "dockerfile",
      dockerfileContent: "FROM node:24-alpine\nEXPOSE 99999\n",
      packageJsonRaw: null,
      sourceFileContents: {}
    });
    assert.notEqual(result.detectedPort, 99999);
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

  test("also detects the container port from a Dockerfile EXPOSE on disk", () => {
    writeFileSync(join(checkoutDir, "Dockerfile"), "FROM node:24-alpine\nEXPOSE 53123\n");

    const result = inspectCheckoutDirectory(checkoutDir, ".");
    assert.equal(result.detectedProjectType, "dockerfile");
    assert.equal(result.portDetection.detectedPort, 53123);
    assert.equal(result.portDetection.source, "dockerfile-expose");
  });

  test("also detects the container port from a literal server.js listen call on disk", () => {
    writeFileSync(join(checkoutDir, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
    writeFileSync(join(checkoutDir, "server.js"), "app.listen(53123);\n");

    const result = inspectCheckoutDirectory(checkoutDir, ".");
    assert.equal(result.portDetection.detectedPort, 53123);
    assert.equal(result.portDetection.source, "source-code");
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

  test("also fetches Dockerfile content over the API and attaches port detection", async () => {
    const files: Record<string, string> = { Dockerfile: "FROM node:24-alpine\nEXPOSE 53123\n" };
    const client: SourceProviderClient = {
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
        return path in files;
      },
      async getFileContents(_token, _owner, _repo, _ref, path) {
        if (path in files) {
          return files[path];
        }
        throw new Error("file not found");
      }
    };

    const result = await inspectRepositoryRemote(client, {
      token: "test-token",
      repositoryOwner: "MNIKevin202",
      repositoryName: "mflabs",
      ref: "main",
      subdirectory: "."
    });

    assert.equal(result.detectedProjectType, "dockerfile");
    assert.equal(result.portDetection.detectedPort, 53123);
    assert.equal(result.portDetection.source, "dockerfile-expose");
    assert.equal(result.portDetection.confidence, "high");
  });
});
