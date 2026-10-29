import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, describe, test } from "node:test";
import { readPlatformFacts, openReadOnly } from "../migration/inventory.js";
import {
  describeServer,
  runDestinationPreflight,
  runSourcePreflight,
  type SourcePreflightInput
} from "../migration/preflight.js";
import { createDockerProbe } from "../migration/probes.js";
import { renderReportText, type VerificationReport } from "../migration/report.js";
import { listMigrations } from "../migrations/index.js";
import {
  ALLOWED_DOCKER_CALLS,
  buildSyntheticDatabase,
  FakeDocker,
  GITHUB_TOKEN,
  makeKey,
  MIB,
  type FakeDockerOptions
} from "./migration-env-fixtures.js";
import { cleanupTempDirs, makeFacts, PLANTED_SECRET } from "./migration-fixtures.js";
import type { PlatformFacts } from "../migration/facts.js";

after(cleanupTempDirs);

const MAX_SCHEMA = Math.max(...listMigrations().map((migration) => migration.version));

interface Run {
  facts?: PlatformFacts;
  docker?: FakeDockerOptions;
  input?: Partial<SourcePreflightInput>;
}

async function runSource({ facts = makeFacts(), docker: dockerOptions, input = {} }: Run = {}) {
  const db = buildSyntheticDatabase(facts);
  const docker = new FakeDocker(facts, dockerOptions);
  const report = await runSourcePreflight({
    scope: "platform",
    operation: "backup",
    facts: readPlatformFacts(db.path),
    docker: createDockerProbe(docker),
    encryption: { available: true, key: db.key },
    platformVersion: "1.9.0",
    maxKnownSchemaVersion: MAX_SCHEMA,
    ...input
  });

  return { report, db, docker, facts };
}

const checkOf = (report: VerificationReport, id: string, subject?: string) =>
  report.checks.find((check) => check.id === id && (subject === undefined || check.subject === subject));

describe("inventory reads the real schema", () => {
  test("round-trips a synthetic estate through the real migrations", () => {
    const facts = makeFacts();
    const db = buildSyntheticDatabase(facts);
    const read = readPlatformFacts(db.path);

    assert.equal(read.schemaVersion, MAX_SCHEMA);
    assert.equal(read.integrityCheck, "ok");
    assert.deepEqual(read.apps, facts.apps);
    assert.deepEqual(read.globalEnv, facts.globalEnv);
    assert.deepEqual(read.databaseConnections, facts.databaseConnections);
    assert.deepEqual(read.credentialProviders, ["github"]);
  });

  test("the handle is read-only: any write attempt throws", () => {
    const db = buildSyntheticDatabase();
    const handle = openReadOnly(db.path);

    try {
      assert.throws(() => handle.exec("INSERT INTO platform_settings (key, value) VALUES ('x', 'y')"));
      assert.throws(() => handle.exec("CREATE TABLE sneaky (id INTEGER)"));
      assert.throws(() => handle.exec("DELETE FROM apps"));
    } finally {
      handle.close();
    }
  });

  test("a missing optional table is an empty list, not an error", () => {
    const db = buildSyntheticDatabase(makeFacts({ apps: [], globalEnv: [], databaseConnections: [], credentialProviders: [] }));
    const read = readPlatformFacts(db.path);

    assert.deepEqual(read.apps, []);
  });
});

describe("source preflight (platform scope)", () => {
  test("a healthy synthetic estate is ready with warnings, never blocked", async () => {
    const { report } = await runSource();

    assert.equal(report.kind, "preflight");
    assert.equal(report.role, "source");
    assert.equal(report.scope, "platform");
    assert.equal(report.verdict, "ready-with-warnings");
    assert.equal(report.summary.fail, 0);

    for (const id of [
      "source.database.readable",
      "source.database.integrity",
      "source.schema.version",
      "source.docker.reachable",
      "source.crypto.key",
      "source.crypto.credentials"
    ]) {
      assert.equal(checkOf(report, id)?.status, "pass", id);
    }
  });

  test("a database is NOT reported as consistent merely because stopping it is possible", async () => {
    const { report } = await runSource();
    const db = checkOf(report, "source.app.consistency", "app:2");

    assert.equal(db?.status, "warn");
    assert.match(db!.detail, /postgres database/);
    assert.match(db!.detail, /quiesced-unverified/);
    assert.match(db!.detail, /not application consistency/);
    assert.match(db!.remediation!, /pg_dump|pg_controldata/);

    const unknown = checkOf(report, "source.app.consistency", "app:1");
    assert.equal(unknown?.status, "warn"); // an unrecognised volume is never assumed safe
    assert.match(unknown!.detail, /unknown type/);

    assert.equal(checkOf(report, "source.app.consistency", "app:4")?.status, "pass"); // stateless
  });

  test("per-app assessments carry profile, volume and image facts", async () => {
    const { report } = await runSource();
    const apps = report.sections.apps as Array<{
      ref: string;
      profile: { kind: string };
      volumes: Array<{ sizeBytes: number | null; exists: boolean }>;
      images: Array<{ role: string; local: boolean }>;
      consistency: { cutoverWithoutEvidence: string; levelWithoutEvidence: string };
    }>;
    const db = apps.find((app) => app.ref === "app:2")!;
    const web = apps.find((app) => app.ref === "app:1")!;

    assert.equal(db.profile.kind, "postgres");
    assert.equal(db.volumes[0]?.sizeBytes, 50 * MIB);
    assert.equal(db.consistency.levelWithoutEvidence, "quiesced-unverified");
    assert.equal(db.consistency.cutoverWithoutEvidence, "needs-evidence-or-acceptance");
    assert.deepEqual(
      web.images.map((image) => [image.role, image.local]),
      [["current", true], ["rollback", true]]
    );
    assert.equal(apps.find((app) => app.ref === "app:4")!.consistency.cutoverWithoutEvidence, "not-applicable");
  });

  test("estimates the transfer size from volumes and carried images", async () => {
    const { report } = await runSource();
    const estimates = report.sections.estimates as { transferBytes: number; requiredFreeBytes: number };

    // volumes: 5 MiB (web) + 50 MiB (db); local build images: 2 x 100 MiB
    assert.equal(estimates.transferBytes, 55 * MIB + 200 * MIB);
    assert.ok(estimates.requiredFreeBytes > estimates.transferBytes);
  });

  test("detects unhealthy and unsupported situations", async () => {
    const { report } = await runSource({
      docker: {
        stoppedContainers: ["app-worker"],
        missingContainers: ["app-static"],
        missingVolumes: ["web-uploads"],
        missingImages: ["deployment-app-1:000111222333"],
        privileged: ["app-db"],
        bindMounts: { "app-web": "/host-data" }
      },
      facts: makeFacts({
        activeDeploymentLockAppIds: [1],
        lastUpdate: { result: "migrating", toVersion: "1.10.0", finishedAt: null }
      })
    });

    assert.equal(checkOf(report, "source.app.runtime", "app:3")?.status, "warn");
    assert.match(checkOf(report, "source.app.runtime", "app:3")!.detail, /exited/);
    assert.match(checkOf(report, "source.app.runtime", "app:4")!.detail, /does not exist/);
    assert.match(checkOf(report, "source.app.volumes", "app:1")!.detail, /web-uploads/);
    assert.match(checkOf(report, "source.app.images", "app:1")!.detail, /no longer exist locally/);
    assert.match(checkOf(report, "source.app.mounts", "app:2")!.detail, /privileged/);
    assert.match(checkOf(report, "source.app.mounts", "app:1")!.detail, /bind mounts at \/host-data/);
    assert.equal(checkOf(report, "source.activity.deployments")?.status, "warn");
    assert.equal(checkOf(report, "source.activity.updater")?.status, "warn");
    assert.match(checkOf(report, "source.activity.updater")!.detail, /1\.10\.0/);
  });

  test("a stuck previous update is surfaced", async () => {
    const { report } = await runSource({
      facts: makeFacts({ lastUpdate: { result: "manual_intervention_required", toVersion: "1.9.1", finishedAt: "2026-01-01T00:00:00Z" } })
    });

    assert.match(checkOf(report, "source.activity.updater")!.detail, /manual_intervention_required/);
  });

  test("credentials that cannot be decrypted block the migration", async () => {
    const facts = makeFacts();
    const db = buildSyntheticDatabase(facts, makeKey());
    const report = await runSourcePreflight({
      scope: "platform",
      operation: "backup",
      facts: readPlatformFacts(db.path),
      docker: createDockerProbe(new FakeDocker(facts)),
      encryption: { available: true, key: makeKey() }, // the WRONG key
      platformVersion: "1.9.0",
      maxKnownSchemaVersion: MAX_SCHEMA
    });

    assert.equal(report.verdict, "blocked");
    assert.equal(checkOf(report, "source.crypto.credentials")?.status, "fail");
    assert.match(checkOf(report, "source.crypto.credentials")!.detail, /github/);
  });

  test("a missing key blocks when credentials exist, and only warns when they do not", async () => {
    const withCreds = await runSource({ input: { encryption: { available: false, reason: "missing" } } });
    assert.equal(checkOf(withCreds.report, "source.crypto.key")?.status, "fail");

    const noCreds = await runSource({
      facts: makeFacts({ credentialProviders: [] }),
      input: { encryption: { available: false, reason: "missing" } }
    });
    assert.equal(checkOf(noCreds.report, "source.crypto.key")?.status, "warn");
  });

  test("Docker being unreachable blocks and stops early", async () => {
    const { report } = await runSource({ docker: { failInfo: true } });

    assert.equal(report.verdict, "blocked");
    assert.equal(checkOf(report, "source.docker.reachable")?.status, "fail");
    assert.equal(checkOf(report, "source.app.runtime"), undefined);
  });

  test("an unreadable database, a damaged one and a too-new schema each block", async () => {
    const docker = createDockerProbe(new FakeDocker(makeFacts()));
    const base = {
      scope: "platform" as const,
      operation: "backup" as const,
      docker,
      encryption: { available: false as const, reason: "missing" as const },
      platformVersion: "1.9.0",
      maxKnownSchemaVersion: MAX_SCHEMA
    };

    const unreadable = await runSourcePreflight({ ...base, facts: null, factsError: "unable to open database file" });
    assert.equal(unreadable.verdict, "blocked");
    assert.match(checkOf(unreadable, "source.database.readable")!.detail, /unable to open/);

    const db = buildSyntheticDatabase();
    const facts = readPlatformFacts(db.path);
    const damaged = await runSourcePreflight({ ...base, facts: { ...facts, integrityCheck: "row 3 missing from index" } });
    assert.equal(checkOf(damaged, "source.database.integrity")?.status, "fail");

    const tooNew = await runSourcePreflight({ ...base, facts: { ...facts, schemaVersion: MAX_SCHEMA + 5 } });
    assert.equal(checkOf(tooNew, "source.schema.version")?.status, "fail");
  });

  test("free-space check: insufficient fails, tight warns, plentiful passes, unknown is skipped", async () => {
    const need = (await runSource()).report.sections.estimates as { requiredFreeBytes: number };

    const fail = await runSource({ input: { outputFreeBytes: need.requiredFreeBytes - 1 } });
    assert.equal(checkOf(fail.report, "source.disk.space")?.status, "fail");
    assert.equal(fail.report.verdict, "blocked");

    const warn = await runSource({ input: { outputFreeBytes: Math.ceil(need.requiredFreeBytes * 1.2) } });
    assert.equal(checkOf(warn.report, "source.disk.space")?.status, "warn");

    const pass = await runSource({ input: { outputFreeBytes: need.requiredFreeBytes * 3 } });
    assert.equal(checkOf(pass.report, "source.disk.space")?.status, "pass");

    assert.equal(checkOf((await runSource()).report, "source.disk.space")?.status, "skip");
    assert.equal(
      checkOf((await runSource({ docker: { failDf: true } })).report, "source.docker.usage")?.status,
      "warn"
    );
  });

  test("states that the bundle will be fully encrypted", async () => {
    const { report } = await runSource();

    assert.match(checkOf(report, "source.bundle.encryption")!.detail, /database, configuration, volumes and images/);
  });
});

describe("source preflight (application scope)", () => {
  test("an app that addresses a private database is blocked until the database joins", async () => {
    const blocked = await runSource({ input: { scope: "application", operation: "move", appId: 1 } });

    assert.equal(blocked.report.verdict, "blocked");
    assert.equal(checkOf(blocked.report, "source.dependencies")?.status, "fail");
    assert.match(checkOf(blocked.report, "source.dependencies")!.remediation!, /app:2/);
    assert.equal(blocked.report.application?.name, "web");

    const resolved = await runSource({ input: { scope: "application", operation: "move", appId: 1, selection: [2, 3] } });
    assert.equal(checkOf(resolved.report, "source.dependencies")?.status, "warn"); // external DB + credential still need attention
    assert.equal(resolved.report.summary.fail, 0);
    // The selection widens the assessment to the apps moving together.
    const refs = (resolved.report.sections.apps as Array<{ ref: string }>).map((app) => app.ref);
    assert.deepEqual(refs, ["app:1", "app:2", "app:3"]);
  });

  test("an independent app is clean and lists no dependency blockers", async () => {
    const { report } = await runSource({ input: { scope: "application", operation: "move", appId: 4 } });

    assert.equal(checkOf(report, "source.dependencies")?.status, "pass");
    // A move is not "ready" until a destination has been checked.
    assert.equal(report.verdict, "ready-with-warnings");
    assert.equal(checkOf(report, "destination.evaluated")?.status, "warn");
    assert.match(checkOf(report, "destination.evaluated")!.remediation!, /migrate describe/);
  });

  test("a plain backup does not need a destination", async () => {
    const { report } = await runSource({ input: { scope: "application", operation: "backup", appId: 4 } });

    assert.equal(checkOf(report, "destination.evaluated")?.status, "skip");
  });

  test("an unknown app fails clearly", async () => {
    const { report } = await runSource({ input: { scope: "application", operation: "copy", appId: 99 } });

    assert.equal(report.verdict, "blocked");
    assert.equal(checkOf(report, "source.app.exists")?.status, "fail");
  });

  test("side effects that a non-owner copy must keep off are reported", async () => {
    const { report } = await runSource({ input: { scope: "application", operation: "copy", appId: 1, selection: [2, 3] } });

    assert.match(checkOf(report, "source.sideeffects")!.detail, /cron: nightly-sync/);
    assert.match(checkOf(report, "source.sideeffects")!.detail, /auto-deploy/);
    assert.match(checkOf(report, "source.sideeffects")!.detail, /stay disabled/);
  });

  test("evaluates a described destination: conflicts, capability and credential handling", async () => {
    const facts = makeFacts();
    const destinationFacts = makeFacts({
      apps: [
        { ...facts.apps[3]!, id: 1, name: "web", containerName: "app-web", domain: "web.example.test", publishedPorts: [{ hostPort: 25565, containerPort: 25565, protocol: "udp" }] }
      ],
      globalEnv: [],
      credentialProviders: []
    });
    const destinationDb = buildSyntheticDatabase(destinationFacts);
    const descriptor = await describeServer({
      docker: createDockerProbe(new FakeDocker(destinationFacts, { extraVolumes: [{ name: "web-uploads" }] })),
      facts: readPlatformFacts(destinationDb.path),
      platformVersion: "1.9.0",
      maxSchemaVersion: MAX_SCHEMA,
      encryption: { available: true, key: destinationDb.key },
      diskPath: null
    });

    const { report } = await runSource({
      facts,
      input: { scope: "application", operation: "copy", appId: 1, selection: [2, 3], destination: descriptor }
    });

    assert.equal(report.verdict, "blocked");
    for (const kind of ["app-name", "container-name", "domain", "host-port", "volume"]) {
      assert.equal(checkOf(report, `destination.conflicts.${kind}`)?.status, "fail", kind);
    }
    assert.equal(checkOf(report, "destination.conflicts.volume")?.data?.count, 1);
    assert.match(checkOf(report, "destination.conflicts.volume")!.remediation!, /will NOT be overwritten/);
    assert.equal(checkOf(report, "destination.import.available")?.status, "warn"); // honest about this build
    assert.match(checkOf(report, "destination.credentials.key")!.detail, /re-encrypted for the destination/);
    assert.match(checkOf(report, "destination.credentials.key")!.detail, /never replaced/);
  });

  test("architecture mismatch with locally built images is a hard failure", async () => {
    const facts = makeFacts();
    const descriptor = await describeServer({
      docker: createDockerProbe(new FakeDocker(makeFacts({ apps: [] }), { arch: "aarch64" })),
      facts: null,
      platformVersion: "1.9.0",
      maxSchemaVersion: MAX_SCHEMA,
      encryption: { available: false, reason: "missing" },
      diskPath: null
    });
    const { report } = await runSource({
      facts,
      input: { scope: "application", operation: "copy", appId: 1, selection: [2, 3], destination: descriptor }
    });

    assert.equal(checkOf(report, "destination.compatibility.architecture-mismatch")?.status, "fail");
    assert.equal(checkOf(report, "destination.platform.installed")?.status, "fail"); // facts: null => not installed
  });
});

describe("the read-only guarantee", () => {
  test("only query operations reach Docker", async () => {
    const { docker } = await runSource();

    assert.ok(docker.calls.length > 5);
    for (const call of docker.calls) {
      assert.match(call, ALLOWED_DOCKER_CALLS, `unexpected Docker call: ${call}`);
    }
  });

  test("the database file and its directory are byte-for-byte unchanged", async () => {
    const facts = makeFacts();
    const db = buildSyntheticDatabase(facts);
    const directory = dirname(db.path);
    const fingerprint = () =>
      JSON.stringify({
        files: readdirSync(directory).sort(),
        sha256: createHash("sha256").update(readFileSync(db.path)).digest("hex")
      });
    const before = fingerprint();

    await runSourcePreflight({
      scope: "platform",
      operation: "backup",
      facts: readPlatformFacts(db.path),
      docker: createDockerProbe(new FakeDocker(facts)),
      encryption: { available: true, key: db.key },
      platformVersion: "1.9.0",
      maxKnownSchemaVersion: MAX_SCHEMA
    });

    assert.equal(fingerprint(), before);
  });

  test("preflight does not run schema migrations on an older database", async () => {
    const facts = makeFacts();
    const db = buildSyntheticDatabase(facts);
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(db.path);
    raw.exec("DROP TABLE platform_update_history; DELETE FROM schema_migrations WHERE version = 28");
    raw.close();

    const read = readPlatformFacts(db.path);
    assert.equal(read.schemaVersion, 27); // reported as found...
    const verify = new DatabaseSync(db.path, { readOnly: true });
    const max = (verify.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
    verify.close();
    assert.equal(max, 27); // ...and NOT upgraded by reading it
  });
});

describe("reports never contain secrets", () => {
  test("no secret value, key, token, connection string or cron command appears in JSON or text", async () => {
    const forbidden: Array<[string, string]> = [];
    const runs = [
      await runSource(),
      await runSource({ input: { scope: "application", operation: "move", appId: 1, selection: [2, 3] } }),
      await runSource({ input: { scope: "application", operation: "copy", appId: 1 } })
    ];

    for (const { report, db } of runs) {
      forbidden.push(
        [PLANTED_SECRET, "environment value"],
        [GITHUB_TOKEN, "decrypted credential"],
        [db.key.toString("base64"), "encryption key (base64)"],
        [db.key.toString("hex"), "encryption key (hex)"],
        ["cluster.example.test", "connection string"],
        ["Authorization", "cron command"],
        ["api.example.test", "cron command"],
        ["rm -rf", "cron command"]
      );

      const json = JSON.stringify(report);
      const text = renderReportText(report);
      for (const [needle, what] of forbidden) {
        assert.ok(!json.includes(needle), `${what} leaked into JSON`);
        assert.ok(!text.includes(needle), `${what} leaked into text`);
      }
    }
  });

  test("the text rendering states that nothing was modified", async () => {
    const { report } = await runSource();
    const text = renderReportText(report);

    assert.match(text, /read-only inspection/);
    assert.match(text, /Verdict:\s+READY WITH WARNINGS/);
    assert.match(text, /\[WARN\] db: data consistency \(app:2\)/);
  });
});

describe("destination descriptor", () => {
  test("describes capabilities honestly and exposes only a one-way key id", async () => {
    const facts = makeFacts({ apps: [] });
    const db = buildSyntheticDatabase(facts);
    const descriptor = await describeServer({
      docker: createDockerProbe(new FakeDocker(facts)),
      facts: readPlatformFacts(db.path),
      platformVersion: "1.9.0",
      maxSchemaVersion: MAX_SCHEMA,
      encryption: { available: true, key: db.key },
      diskPath: null
    });

    assert.equal(descriptor.platform.installed, true);
    assert.deepEqual(descriptor.platform.capabilities, { preflight: true, bundleVerify: true, export: false, import: false });
    assert.match(descriptor.server.serverId, /^srv-[0-9a-f]{16}$/);
    assert.match(descriptor.credentialKeyId!, /^[0-9a-f]{16}$/);

    const serialized = JSON.stringify(descriptor);
    assert.ok(!serialized.includes(db.key.toString("base64")));
    assert.ok(!serialized.includes("SYNTHETIC-DAEMON-ID-0001")); // raw daemon id never exposed
  });

  test("destination preflight without a bundle reports what it can and skips the rest", async () => {
    const facts = makeFacts({ apps: [] });
    const db = buildSyntheticDatabase(facts);
    const descriptor = await describeServer({
      docker: createDockerProbe(new FakeDocker(facts)),
      facts: readPlatformFacts(db.path),
      platformVersion: "1.9.0",
      maxSchemaVersion: MAX_SCHEMA,
      encryption: { available: true, key: db.key },
      diskPath: null
    });
    const report = await runDestinationPreflight({ descriptor });

    assert.equal(report.role, "destination");
    assert.equal(checkOf(report, "destination.platform.installed")?.status, "pass");
    assert.equal(checkOf(report, "destination.bundle.supplied")?.status, "skip");
  });
});
