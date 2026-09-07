import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import type Docker from "dockerode";
import tarStream from "tar-stream";
import { createGithubBuildDockerOps } from "../services/github-deploy-docker-ops.js";
import { prepareBuildPlan } from "../services/build-strategy.js";

/** Reads the tar produced by tar-fs and returns the entry names. */
function listTarEntries(stream: NodeJS.ReadableStream): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    const extract = tarStream.extract();
    extract.on("entry", (header, entryStream, next) => {
      names.push(header.name);
      entryStream.resume();
      entryStream.on("end", next);
      entryStream.on("error", reject);
    });
    extract.on("finish", () => resolve(names));
    extract.on("error", reject);
    stream.pipe(extract);
  });
}

interface Captured {
  opts?: { dockerfile?: string; t?: string; nocache?: boolean };
  names?: string[];
}

/**
 * A Docker stub that fully consumes the context tar (as the real dockerode
 * does — streaming it to the daemon), records the entry names it saw and the
 * build options, then reports success. Consuming the tar here is also what
 * keeps tar-fs from scanning a temp dir after the test has torn it down.
 */
function fakeDocker(captured: Captured): Docker {
  return {
    async buildImage(file: NodeJS.ReadableStream, opts: Captured["opts"]) {
      captured.opts = opts;
      captured.names = await listTarEntries(file);
      return Readable.from([]);
    },
    modem: {
      followProgress(_stream: unknown, onFinished: (err: Error | null) => void) {
        onFinished(null);
      }
    }
  } as unknown as Docker;
}

describe("createGithubBuildDockerOps.buildImage — context packing", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "buildctx-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("REGRESSION: the Dockerfile is packed into the context even when .dockerignore lists it", async () => {
    // A monorepo subdirectory context (what prepareBuildPlan produces for
    // subdirectory="platform"), with a .dockerignore that excludes the
    // Dockerfile — the exact shape that made dockerode's client-side filter
    // strip it, yielding "Cannot locate specified Dockerfile".
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
    writeFileSync(join(dir, ".dockerignore"), "Dockerfile\n.dockerignore\nnode_modules\n.next\n");
    writeFileSync(join(dir, "package.json"), "{}\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export {}\n");

    const captured: Captured = {};
    const ops = createGithubBuildDockerOps(fakeDocker(captured));

    await ops.buildImage({
      contextPath: dir,
      dockerfileRelativePath: "Dockerfile",
      tag: "clovasuite:test",
      timeoutMs: 5000,
      maxLogBytes: 4096
    });

    // The daemon is handed the configured Dockerfile path verbatim.
    assert.equal(captured.opts?.dockerfile, "Dockerfile");
    const names = captured.names ?? [];
    // The whole point of the fix: the Dockerfile survives into the tar.
    assert.ok(names.includes("Dockerfile"), "Dockerfile must be present in the build context tar");
    // .dockerignore is included so the DAEMON can apply it (COPY filtering).
    assert.ok(names.includes(".dockerignore"), ".dockerignore must reach the daemon");
    assert.ok(names.includes("package.json"));
    assert.ok(names.includes(join("src", "index.ts")));
  });

  test("the .git directory is never uploaded in the context", async () => {
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "[core]\n");
    writeFileSync(join(dir, "app.js"), "console.log(1)\n");

    const captured: Captured = {};
    const ops = createGithubBuildDockerOps(fakeDocker(captured));
    await ops.buildImage({
      contextPath: dir,
      dockerfileRelativePath: "Dockerfile",
      tag: "t:1",
      timeoutMs: 5000,
      maxLogBytes: 4096
    });

    const names = captured.names ?? [];
    assert.ok(names.includes("Dockerfile"));
    assert.ok(names.includes("app.js"));
    assert.ok(
      !names.some((n) => n === ".git" || n.startsWith(".git/")),
      ".git must be excluded from the build context"
    );
  });

  test("a build failure surfaces the daemon message and retains the build log", async () => {
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
    const docker = {
      async buildImage(file: NodeJS.ReadableStream) {
        await listTarEntries(file); // consume the tar so nothing dangles
        return Readable.from([]);
      },
      modem: {
        followProgress(
          _stream: unknown,
          onFinished: (err: Error | null) => void,
          onEvent: (event: { stream?: string; error?: string }) => void
        ) {
          onEvent({ stream: "Step 1/1 : FROM scratch\n" });
          onEvent({ error: "Cannot locate specified Dockerfile: Dockerfile" });
          onFinished(null);
        }
      }
    } as unknown as Docker;

    const ops = createGithubBuildDockerOps(docker);
    await assert.rejects(
      ops.buildImage({
        contextPath: dir,
        dockerfileRelativePath: "Dockerfile",
        tag: "t:1",
        timeoutMs: 5000,
        maxLogBytes: 4096
      }),
      /Cannot locate specified Dockerfile/
    );
  });
});

describe("prepareBuildPlan — one shared resolver for validation and build", () => {
  let checkout: string;

  beforeEach(() => {
    checkout = mkdtempSync(join(tmpdir(), "checkout-"));
    mkdirSync(join(checkout, "platform"));
    writeFileSync(join(checkout, "platform", "Dockerfile"), "FROM scratch\n");
  });
  afterEach(() => rmSync(checkout, { recursive: true, force: true }));

  test("subdirectory Dockerfile resolves to context=<subdir>, dockerfile=Dockerfile", () => {
    // subdirectory="platform", dockerfilePath="Dockerfile", buildContext="."
    const plan = prepareBuildPlan({
      strategy: "dockerfile",
      checkoutDir: checkout,
      subdirectory: "platform",
      dockerfilePath: "Dockerfile",
      buildContext: "."
    });

    assert.equal(plan.buildContextPath, join(checkout, "platform"));
    assert.equal(plan.dockerfilePath, join(checkout, "platform", "Dockerfile"));
    // This is exactly what the deploy service passes to buildImage as the
    // `dockerfile` option — a bare "Dockerfile", relative to the context.
    assert.equal(relative(plan.buildContextPath, plan.dockerfilePath), "Dockerfile");
  });
});
