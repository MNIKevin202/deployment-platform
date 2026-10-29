import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { verifyBundle } from "../migration/bundle.js";
import { runCli, type CliEnvironment, type CliResult } from "../migration/cli.js";
import type { ExportEnvironment } from "../migration/export-cli.js";
import { readPlatformFacts } from "../migration/inventory.js";
import { readPassphraseFile } from "../migration/passphrase.js";
import { createDockerProbe } from "../migration/probes.js";
import { listMigrations } from "../migrations/index.js";
import { createPrivateKey } from "node:crypto";
import { makeHarness, type Harness } from "./export-harness.js";
import { FakeDocker, GITHUB_TOKEN } from "./migration-env-fixtures.js";
import { cleanupTempDirs, makeTempDir, PLANTED_SECRET, TEST_PASSPHRASE } from "./migration-fixtures.js";

after(cleanupTempDirs);

const MAX_SCHEMA = Math.max(...listMigrations().map((m) => m.version));

function passphraseFile(): string {
  const path = join(makeTempDir("cfmig-pass-"), "passphrase");
  writeFileSync(path, `${TEST_PASSPHRASE}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);

  return path;
}

function envFor(h: Harness, overrides: { exporter?: Partial<ExportEnvironment>; infoFails?: boolean } = {}): { env: CliEnvironment; logs: string[] } {
  const logs: string[] = [];
  const exporter: ExportEnvironment = {
    createClient: () => h.fake,
    configDir: h.configDir,
    routesDir: h.routesDir,
    stateDir: h.stateDir,
    helperImage: "helper:local",
    log: (message) => void logs.push(message),
    writeNewFile: (path, content, mode) => writeFileSync(path, content, { flag: "wx", mode }),
    readSigningKey: (path) => {
      const pem = readFileSync(path, "utf8");
      createPrivateKey(pem);
      return pem;
    },
    dbSize: () => 100_000,
    ...overrides.exporter
  };

  return {
    logs,
    env: {
      readText: (path) => readFileSync(path, "utf8"),
      readPassphrase: readPassphraseFile,
      fileExists: existsSync,
      readFacts: readPlatformFacts,
      createProbe: () => createDockerProbe(new FakeDocker(h.facts, { failInfo: overrides.infoFails })),
      loadEncryption: () => ({ available: true, key: h.key }),
      freeSpace: () => ({ free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }),
      platformVersion: "1.9.0",
      defaultDbPath: h.dbPath,
      maxSchemaVersion: MAX_SCHEMA,
      now: () => new Date("2026-01-01T00:00:00Z"),
      exporter
    }
  };
}

const mutating = (h: Harness): string[] => h.fake.calls.filter((call) => /^(stop|start|pause|unpause|volumeArchive|exec|imageSave):/.test(call));
const base = (h: Harness, extra: string[] = []): string[] => ["export", "--output-dir", h.outputDir, "--passphrase-file", passphraseFile(), "--bundle-name", "bundle", ...extra];

describe("migrate export", () => {
  test("a platform rehearsal export writes a verifiable encrypted bundle and says what it did", async () => {
    const h = await makeHarness();
    const { env } = envFor(h);
    const result = await runCli(base(h), env);

    assert.ok([0, 10].includes(result.exitCode), result.stderr + result.stdout);
    assert.match(result.stdout, /Export — scope: platform/);
    assert.match(result.stdout, /Encrypted bundle written/);
    assert.match(result.stdout, /No application was stopped or paused/);
    assert.match(result.stdout, /NOT signed/);
    assert.equal((await verifyBundle(join(h.outputDir, "bundle"), TEST_PASSPHRASE, { deep: true })).integrity.status, "verified");
  });

  test("an application export with dependencies works and reports the evidence per volume", async () => {
    const h = await makeHarness();
    const result = await runCli(base(h, ["--scope", "application", "--app", "web", "--with", "db,worker", "--operation", "copy"]), envFor(h).env);

    assert.ok([0, 10].includes(result.exitCode), result.stderr + result.stdout);
    assert.match(result.stdout, /application-consistent via hook — evidence: logical-dump-verified/);
    assert.match(result.stdout, /inconsistent via live — no evidence/);
  });

  test("cutover without evidence is REFUSED with the exact remedy, before anything is touched", async () => {
    const h = await makeHarness();
    const result = await runCli(base(h, ["--scope", "application", "--app", "web", "--with", "db,worker", "--operation", "move", "--mode", "cutover"]), envFor(h).env);

    assert.equal(result.exitCode, 20);
    assert.match(result.stdout, /REFUSED before anything was touched/);
    assert.match(result.stdout, /--accept-risk web=quiesced-unverified/);
    assert.match(result.stdout, /No application was stopped, paused or changed, and no bundle was created/);
    assert.deepEqual(mutating(h), []);
    assert.deepEqual(readdirSync(h.outputDir), []);
  });

  test("with the acceptance, cutover proceeds: the app is stopped, restored, and the report says so", async () => {
    const h = await makeHarness();
    const result = await runCli(
      base(h, ["--scope", "application", "--app", "web", "--with", "db,worker", "--operation", "move", "--mode", "cutover", "--strategy", "stop", "--accept-risk", "web=quiesced-unverified", "--accept-risk", "db=quiesced-unverified"]),
      envFor(h).env
    );

    assert.ok([0, 10].includes(result.exitCode), result.stderr + result.stdout);
    assert.match(result.stdout, /quiesced-unverified via stop/);
    assert.match(result.stdout, /Not proof of application consistency/);
    assert.match(result.stdout, /was stopped for/);
    assert.equal(h.fake.state("app-web").running, true);
  });

  test("a blocked preflight stops the export before it starts", async () => {
    const h = await makeHarness();
    const result = await runCli(base(h), envFor(h, { infoFails: true }).env);

    assert.equal(result.exitCode, 20);
    assert.match(result.stderr, /export was NOT started/);
    assert.deepEqual(mutating(h), []);
  });

  test("a mid-export failure exits 4, says everything was restored, and leaves no bundle", async () => {
    const h = await makeHarness({ webBigBytes: 300_000 });
    h.fake.volumeFaults.set("web-uploads", { failAfterBytes: 100_000, error: new Error("input/output error") });
    const result = await runCli(base(h, ["--scope", "application", "--app", "web", "--with", "db,worker", "--operation", "move", "--mode", "cutover", "--strategy", "stop", "--accept-risk", "web=quiesced-unverified", "--accept-risk", "db=quiesced-unverified"]), envFor(h).env);

    assert.equal(result.exitCode, 4);
    assert.match(result.stderr, /EXPORT FAILED: input\/output error/);
    assert.match(result.stderr, /have been restored/);
    assert.match(result.stderr, /partial bundle was removed/);
    assert.equal(h.fake.state("app-web").running, true);
    assert.deepEqual(readdirSync(h.outputDir), []);
  });

  test("if an app cannot be restored the exit code is 5 and the message is unmissable; `recover` then fixes it", async () => {
    const h = await makeHarness({ webBigBytes: 300_000 });
    h.fake.volumeFaults.set("web-uploads", { failAfterBytes: 100_000 });
    h.fake.faults.push({ op: "start", target: "id-app-web", error: new Error("port is already allocated") });
    const args = base(h, ["--scope", "application", "--app", "web", "--with", "db,worker", "--operation", "move", "--mode", "cutover", "--strategy", "stop", "--accept-risk", "web=quiesced-unverified", "--accept-risk", "db=quiesced-unverified"]);
    const { env } = envFor(h);

    const failed = await runCli(args, env);
    assert.equal(failed.exitCode, 5);
    assert.match(failed.stderr, /THESE APPLICATIONS COULD NOT BE RESTORED/);
    assert.match(failed.stderr, /app-web: .*port is already allocated/);
    assert.match(failed.stderr, /migrate recover/);

    // Still broken: recover says so, loudly.
    const stillBroken = await runCli(["recover", "--force"], env);
    assert.equal(stillBroken.exitCode, 5);
    assert.match(stillBroken.stdout, /COULD NOT restore app-web/);

    h.fake.faults.length = 0;
    const fixed = await runCli(["recover", "--force"], env);
    assert.equal(fixed.exitCode, 0);
    assert.match(fixed.stdout, /restarted app-web/);
    assert.match(fixed.stdout, /Recovery complete/);
    assert.equal(h.fake.state("app-web").running, true);
    assert.match((await runCli(["recover"], env)).stdout, /Nothing to recover/);
  });

  test("Ctrl-C (an abort signal) stops the export safely: exit 4, apps restored", async () => {
    const h = await makeHarness({ webBigBytes: 300_000 });
    h.fake.volumeFaults.set("web-uploads", { stallAfterBytes: 50_000 });
    const controller = new AbortController();
    h.fake.onCall = (op, target) => {
      if (op === "volumeArchive" && target === "web-uploads") {
        setTimeout(() => controller.abort(new Error("cancelled by SIGINT")), 20);
      }
    };
    const { env } = envFor(h, { exporter: { signal: controller.signal } });
    const result = await runCli(base(h, ["--scope", "application", "--app", "web", "--with", "db,worker", "--operation", "move", "--mode", "cutover", "--strategy", "stop", "--accept-risk", "web=quiesced-unverified", "--accept-risk", "db=quiesced-unverified"]), env);

    assert.equal(result.exitCode, 4);
    assert.match(result.stderr, /cancelled by SIGINT/);
    assert.equal(h.fake.state("app-web").running, true);
  });

  test("usage errors: missing flags, bad values, passphrase as an argument", async () => {
    const h = await makeHarness();
    const { env } = envFor(h);

    for (const args of [
      ["export"],
      ["export", "--output-dir", h.outputDir],
      [...base(h), "--mode", "yolo"],
      [...base(h), "--accept-risk", "web=application-consistent"],
      [...base(h), "--accept-risk", "nonsense"],
      [...base(h), "--app-strategy", "web=teleport"],
      [...base(h), "--gzip-level", "99"],
      [...base(h), "--scope", "application"],
      [...base(h), "--passphrase", "hunter2hunter2"]
    ]) {
      const result = await runCli(args, env);
      assert.equal(result.exitCode, 2, args.join(" "));
      assert.equal(result.stdout, "");
    }
    assert.deepEqual(mutating(h), []);
  });

  test("no secret appears in the output, in text or JSON", async () => {
    const h = await makeHarness();
    for (const format of ["text", "json"]) {
      const result = await runCli(base(h, ["--scope", "application", "--app", "web", "--with", "db,worker", "--format", format, "--bundle-name", `b-${format}`]), envFor(h).env);
      const output = result.stdout + result.stderr;

      for (const needle of [PLANTED_SECRET, GITHUB_TOKEN, TEST_PASSPHRASE, h.key.toString("base64"), "synthetic-pg-password"]) {
        assert.ok(!output.includes(needle), `${format}: leaked ${needle.slice(0, 10)}…`);
      }
    }
  });
});

describe("migrate signing-key", () => {
  test("generate creates a private key once, prints its fingerprint, and never overwrites", async () => {
    const h = await makeHarness();
    const { env } = envFor(h);
    const dir = makeTempDir("cfmig-key-");

    const created = await runCli(["signing-key", "generate", "--output-dir", dir], env);
    assert.equal(created.exitCode, 0);
    assert.match(created.stdout, /sha256:[0-9a-f]{64}/);
    assert.match(readFileSync(join(dir, "migration-signing-key.pem"), "utf8"), /BEGIN PRIVATE KEY/);

    const again = await runCli(["signing-key", "generate", "--output-dir", dir], env);
    assert.equal(again.exitCode, 2);
    assert.match(again.stderr, /never overwritten/);

    const fingerprint = /(sha256:[0-9a-f]{64})/.exec(created.stdout)![1];
    const shown = await runCli(["signing-key", "fingerprint", "--key-file", join(dir, "migration-signing-key.pem")], env);
    assert.equal(shown.stdout.trim(), fingerprint);
  });

  test("a signed export reports the fingerprint, and the bundle verifies against it (origin-verified)", async () => {
    const h = await makeHarness();
    const { env } = envFor(h);
    const dir = makeTempDir("cfmig-key-");
    const created = await runCli(["signing-key", "generate", "--output-dir", dir], env);
    const fingerprint = /(sha256:[0-9a-f]{64})/.exec(created.stdout)![1]!;

    const result = await runCli(base(h, ["--signing-key-file", join(dir, "migration-signing-key.pem")]), env);
    assert.ok([0, 10].includes(result.exitCode), result.stderr);
    assert.ok(result.stdout.includes(fingerprint));
    assert.equal((await verifyBundle(join(h.outputDir, "bundle"), TEST_PASSPHRASE, { expectedSignerFingerprint: fingerprint })).authenticity.status, "origin-verified");
  });

  test("subcommand and argument errors", async () => {
    const { env } = envFor(await makeHarness());

    assert.equal((await runCli(["signing-key"], env)).exitCode, 2);
    assert.equal((await runCli(["signing-key", "generate"], env)).exitCode, 2);
    assert.equal((await runCli(["signing-key", "fingerprint"], env)).exitCode, 2);
    assert.equal((await runCli(["signing-key", "explode"], env)).exitCode, 2);
  });
});

describe("environments without the exporter", () => {
  test("export, recover and signing-key are unavailable, not crashes", async () => {
    const h = await makeHarness();
    const { env } = envFor(h);
    const readOnly: CliEnvironment = { ...env, exporter: undefined };

    for (const args of [["export"], ["recover"], ["signing-key", "generate"]]) {
      const result: CliResult = await runCli(args, readOnly);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /not available in this environment/);
    }
  });
});
