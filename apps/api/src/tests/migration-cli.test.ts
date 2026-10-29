import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { runCli, USAGE, type CliEnvironment, type CliResult } from "../migration/cli.js";
import { parseDescriptor } from "../migration/destination.js";
import { readPlatformFacts } from "../migration/inventory.js";
import { readPassphraseFile } from "../migration/passphrase.js";
import { createDockerProbe } from "../migration/probes.js";
import type { PlatformFacts } from "../migration/facts.js";
import { listMigrations } from "../migrations/index.js";
import { buildSyntheticDatabase, FakeDocker, GITHUB_TOKEN, type FakeDockerOptions } from "./migration-env-fixtures.js";
import {
  buildSyntheticBundle,
  cleanupTempDirs,
  makeFacts,
  makeTempDir,
  PLANTED_SECRET,
  TEST_PASSPHRASE
} from "./migration-fixtures.js";

after(cleanupTempDirs);

const MAX_SCHEMA = Math.max(...listMigrations().map((migration) => migration.version));

function makeEnv(
  facts: PlatformFacts = makeFacts(),
  dockerOptions?: FakeDockerOptions,
  overrides: Partial<CliEnvironment> = {}
): { env: CliEnvironment; dbPath: string; key: Buffer } {
  const db = buildSyntheticDatabase(facts);

  return {
    dbPath: db.path,
    key: db.key,
    env: {
      readText: (path) => readFileSync(path, "utf8"),
      readPassphrase: readPassphraseFile,
      fileExists: existsSync,
      readFacts: readPlatformFacts,
      createProbe: () => createDockerProbe(new FakeDocker(facts, dockerOptions)),
      loadEncryption: () => ({ available: true, key: db.key }),
      freeSpace: () => ({ free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }),
      platformVersion: "1.9.0",
      defaultDbPath: db.path,
      maxSchemaVersion: MAX_SCHEMA,
      now: () => new Date("2026-01-01T00:00:00Z"),
      ...overrides
    }
  };
}

function passphraseFile(passphrase = TEST_PASSPHRASE): string {
  const path = join(makeTempDir("cfmig-pass-"), "passphrase");
  writeFileSync(path, `${passphrase}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);

  return path;
}

const json = (result: CliResult) => JSON.parse(result.stdout);

describe("cli: usage and argument handling", () => {
  test("no command prints usage and exits 2; --help exits 0", async () => {
    const { env } = makeEnv();

    const none = await runCli([], env);
    assert.equal(none.exitCode, 2);
    assert.equal(none.stdout, USAGE);

    const help = await runCli(["--help"], env);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /Nothing here modifies any server/);
  });

  test("unknown commands, options and values are usage errors, not crashes", async () => {
    const { env } = makeEnv();

    for (const args of [
      ["frobnicate"],
      ["preflight", "--nonsense"],
      ["preflight", "--format", "xml"],
      ["preflight", "--role", "middle"],
      ["preflight", "--scope", "galaxy"],
      ["preflight", "--operation", "teleport"],
      ["preflight", "extra-positional"],
      ["preflight", "--output-free-bytes", "lots"]
    ]) {
      const result = await runCli(args, env);
      assert.equal(result.exitCode, 2, args.join(" "));
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.length > 0);
    }
  });

  test("a passphrase is never accepted as an argument", async () => {
    const { env } = makeEnv();
    const bundle = await buildSyntheticBundle();

    for (const flag of ["--passphrase", "--password", "--passphrase-value"]) {
      const result = await runCli(["verify-bundle", "--bundle", bundle.directory, flag, TEST_PASSPHRASE], env);
      assert.equal(result.exitCode, 2, flag);
      assert.ok(!result.stderr.includes(TEST_PASSPHRASE) || result.stderr.includes("Usage"), "passphrase echoed");
    }

    const missing = await runCli(["verify-bundle", "--bundle", bundle.directory], env);
    assert.equal(missing.exitCode, 2);
    assert.match(missing.stderr, /--passphrase-file/);
  });

  test("application scope needs --app; platform scope rejects it", async () => {
    const { env } = makeEnv();

    assert.match((await runCli(["preflight", "--scope", "application"], env)).stderr, /needs --app/);
    assert.match((await runCli(["preflight", "--app", "web"], env)).stderr, /only apply to --scope application/);
    assert.match((await runCli(["preflight", "--scope", "application", "--app", "nope"], env)).stderr, /No application named "nope"/);
    assert.match((await runCli(["preflight", "--scope", "application", "--app", "99"], env)).stderr, /No application with id 99/);
    assert.match(
      (await runCli(["preflight", "--scope", "application", "--app", "web", "--with", "ghost"], env)).stderr,
      /No application named "ghost"/
    );
  });
});

describe("cli: describe", () => {
  test("prints a valid descriptor that another server can parse", async () => {
    const { env } = makeEnv();
    const result = await runCli(["describe"], env);

    assert.equal(result.exitCode, 0);
    const descriptor = parseDescriptor(json(result));
    assert.equal(descriptor.platform.installed, true);
    assert.equal(descriptor.platform.version, "1.9.0");
    assert.deepEqual(descriptor.inventory.appNames, ["web", "db", "worker", "static"]);
  });

  test("a server with no platform database is described as not installed", async () => {
    const { env } = makeEnv();
    const result = await runCli(["describe", "--db-path", join(makeTempDir(), "missing.sqlite")], env);

    assert.equal(parseDescriptor(json(result)).platform.installed, false);
  });
});

describe("cli: source preflight", () => {
  test("text output and exit code reflect the verdict", async () => {
    const { env } = makeEnv();
    const result = await runCli(["preflight"], env);

    assert.equal(result.exitCode, 10);
    assert.match(result.stdout, /Source preflight — scope: platform/);
    assert.match(result.stdout, /Verdict:\s+READY WITH WARNINGS/);
    assert.match(result.stdout, /read-only inspection/);
  });

  test("--format json emits the structured report", async () => {
    const { env } = makeEnv();
    const report = json(await runCli(["preflight", "--format", "json"], env));

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, "preflight");
    assert.equal(report.readOnly.guaranteed, true);
    assert.ok(Array.isArray(report.checks));
    assert.equal(report.summary.fail, 0);
  });

  test("a blocked estate exits 20", async () => {
    const { env } = makeEnv(makeFacts(), { failInfo: true });
    const result = await runCli(["preflight"], env);

    assert.equal(result.exitCode, 20);
    assert.match(result.stdout, /\[FAIL\] Docker daemon is reachable/);
  });

  test("a missing database blocks with a clear message", async () => {
    const { env } = makeEnv();
    const result = await runCli(["preflight", "--db-path", join(makeTempDir(), "nothing.sqlite")], env);

    assert.equal(result.exitCode, 20);
    assert.match(result.stdout, /No platform database was found/);
  });

  test("a move is blocked by an unresolved dependency, and unblocked by including it", async () => {
    const { env } = makeEnv();
    const blocked = await runCli(["preflight", "--scope", "application", "--app", "web", "--operation", "move"], env);
    assert.equal(blocked.exitCode, 20);
    assert.match(blocked.stdout, /Dependencies are resolved/);

    const resolved = await runCli(
      ["preflight", "--scope", "application", "--app", "1", "--operation", "move", "--with", "db", "--with", "worker"],
      env
    );
    assert.equal(resolved.exitCode, 10);
  });

  test("free space comes from --output-dir, --output-free-bytes, or an approximation", async () => {
    const seen: string[] = [];
    const { env } = makeEnv(makeFacts(), undefined, {
      freeSpace: (path) => {
        seen.push(path);
        return { free: 1024, total: 2048 };
      }
    });

    const tiny = await runCli(["preflight", "--output-dir", "/somewhere"], env);
    assert.deepEqual(seen, ["/somewhere"]);
    assert.equal(tiny.exitCode, 20);
    assert.match(tiny.stdout, /Enough free space for the export/);

    const explicit = json(await runCli(["preflight", "--format", "json", "--output-free-bytes", String(10 ** 13)], env));
    assert.equal(explicit.checks.find((c: { id: string }) => c.id === "source.disk.space").status, "pass");

    const approx = await runCli(["preflight"], env);
    assert.match(approx.stdout, /approximate; pass --output-dir/);
  });

  test("a destination descriptor from `describe` is used, and a garbage one is rejected safely", async () => {
    const source = makeEnv();
    const destinationFacts = makeFacts({ apps: [], credentialProviders: [], globalEnv: [], databaseConnections: [] });
    const destination = makeEnv(destinationFacts);

    const descriptorFile = join(makeTempDir(), "destination.json");
    writeFileSync(descriptorFile, (await runCli(["describe"], destination.env)).stdout);

    const evaluated = await runCli(
      ["preflight", "--scope", "application", "--app", "static", "--operation", "copy", "--destination-descriptor", descriptorFile],
      source.env
    );
    assert.match(evaluated.stdout, /Destination runs ClovaForge/);
    assert.match(evaluated.stdout, /Destination can import bundles/);

    const garbage = join(makeTempDir(), "bad.json");
    writeFileSync(garbage, JSON.stringify({ schemaVersion: 1, secret: PLANTED_SECRET }));
    const rejected = await runCli(["preflight", "--destination-descriptor", garbage], source.env);
    assert.equal(rejected.exitCode, 2);
    assert.match(rejected.stderr, /not valid/);
    assert.ok(!rejected.stderr.includes(PLANTED_SECRET), "descriptor contents echoed back");
  });
});

describe("cli: destination preflight and bundle verification", () => {
  const cleanDestination = () => makeEnv(makeFacts({ apps: [], credentialProviders: [], globalEnv: [], databaseConnections: [] }));

  test("verifies a bundle against a clean destination", async () => {
    const bundle = await buildSyntheticBundle();
    const result = await runCli(
      ["preflight", "--role", "destination", "--bundle", bundle.directory, "--passphrase-file", passphraseFile()],
      cleanDestination().env
    );

    assert.equal(result.exitCode, 10);
    assert.match(result.stdout, /INTEGRITY\s+VERIFIED/);
    assert.match(result.stdout, /AUTHENTICITY\s+PASSPHRASE-ONLY/);
    assert.match(result.stdout, /Import plan has no conflicts/);
  });

  test("a wrong passphrase exits 20 without saying what the passphrase was", async () => {
    const bundle = await buildSyntheticBundle();
    const wrong = "an entirely different passphrase";
    const result = await runCli(
      ["preflight", "--role", "destination", "--bundle", bundle.directory, "--passphrase-file", passphraseFile(wrong)],
      cleanDestination().env
    );

    assert.equal(result.exitCode, 20);
    assert.match(result.stdout, /passphrase is wrong/);
    assert.ok(!result.stdout.includes(wrong) && !result.stdout.includes(TEST_PASSPHRASE));
  });

  test("a bundle needs its passphrase file", async () => {
    const bundle = await buildSyntheticBundle();
    const result = await runCli(["preflight", "--role", "destination", "--bundle", bundle.directory], cleanDestination().env);

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /never accepted as an argument/);
  });

  test("verify-bundle: unsigned is a warning; a pinned signature is clean; tampering is blocked", async () => {
    const { env } = makeEnv();
    const pass = passphraseFile();

    const unsigned = await buildSyntheticBundle();
    assert.equal((await runCli(["verify-bundle", "--bundle", unsigned.directory, "--passphrase-file", pass], env)).exitCode, 10);
    assert.equal(
      (await runCli(["verify-bundle", "--bundle", unsigned.directory, "--passphrase-file", pass, "--require-signature"], env)).exitCode,
      20
    );

    const signed = await buildSyntheticBundle({ signed: true });
    const clean = await runCli(
      ["verify-bundle", "--bundle", signed.directory, "--passphrase-file", pass, "--deep", "--expect-signer", signed.signer!.fingerprint],
      env
    );
    assert.equal(clean.exitCode, 0);
    assert.match(clean.stdout, /INTEGRITY\s+VERIFIED \(deep/);
    assert.match(clean.stdout, /AUTHENTICITY\s+ORIGIN-VERIFIED/);

    const volume = signed.manifest.artifacts.find((artifact) => artifact.kind === "volume")!;
    truncateSync(join(signed.directory, "artifacts", `${volume.id}.enc`), 40);
    const tampered = await runCli(
      ["verify-bundle", "--bundle", signed.directory, "--passphrase-file", pass, "--expect-signer", signed.signer!.fingerprint],
      env
    );
    assert.equal(tampered.exitCode, 20);
    assert.match(tampered.stdout, /INTEGRITY\s+FAILED/);
    assert.match(tampered.stdout, /AUTHENTICITY\s+ORIGIN-VERIFIED/);
  });

  test("a passphrase file that other users can read is refused", { skip: process.platform === "win32" }, async () => {
    const path = join(makeTempDir("cfmig-pass-"), "loose");
    writeFileSync(path, `${TEST_PASSPHRASE}\n`);
    chmodSync(path, 0o644);
    const bundle = await buildSyntheticBundle();
    const result = await runCli(["verify-bundle", "--bundle", bundle.directory, "--passphrase-file", path], makeEnv().env);

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /chmod 600/);
  });

  test("a too-short passphrase is a usage error", async () => {
    const bundle = await buildSyntheticBundle();
    const result = await runCli(
      ["verify-bundle", "--bundle", bundle.directory, "--passphrase-file", passphraseFile("short")],
      makeEnv().env
    );

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /at least 12 characters/);
  });
});

describe("cli: safety", () => {
  test("an unreachable Docker daemon gives a clear message, not a stack trace", async () => {
    const down = makeEnv(makeFacts(), { failInfo: true });

    for (const args of [["describe"], ["preflight", "--role", "destination"]]) {
      const result = await runCli(args, down.env);

      assert.equal(result.exitCode, 3, args.join(" "));
      assert.match(result.stderr, /^The Docker daemon could not be queried: connect ENOENT/);
      assert.ok(!result.stderr.includes("Internal error"));
      assert.ok(!/\n\s+at /.test(result.stderr), "stack trace leaked");
    }
  });

  test("unexpected failures exit 3 with a one-line message and no stack trace", async () => {
    const { env } = makeEnv(makeFacts(), undefined, {
      createProbe: () => {
        throw new Error("boom");
      }
    });
    const result = await runCli(["preflight"], env);

    assert.equal(result.exitCode, 3);
    assert.equal(result.stderr, "Internal error: boom\n");
  });

  test("no secret appears in any command's output, in either format", async () => {
    const source = makeEnv();
    const forbidden = [PLANTED_SECRET, GITHUB_TOKEN, source.key.toString("base64"), "cluster.example.test", "Authorization"];
    const commands = [
      ["preflight"],
      ["preflight", "--format", "json"],
      ["preflight", "--scope", "application", "--app", "web", "--operation", "copy", "--with", "db,worker"],
      ["preflight", "--scope", "application", "--app", "web", "--operation", "move", "--format", "json"],
      ["describe"]
    ];

    for (const args of commands) {
      const result = await runCli(args, source.env);
      for (const needle of forbidden) {
        assert.ok(!result.stdout.includes(needle) && !result.stderr.includes(needle), `${needle} leaked from: ${args.join(" ")}`);
      }
    }
  });
});

