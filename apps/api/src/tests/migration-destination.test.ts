import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { readPlatformFacts } from "../migration/inventory.js";
import { LABEL_ARTIFACT_SHA256, LABEL_MIGRATION_ID } from "../migration/constants.js";
import { describeServer, runDestinationPreflight } from "../migration/preflight.js";
import { createDockerProbe } from "../migration/probes.js";
import type { VerificationReport } from "../migration/report.js";
import { fingerprintOf, generateSigningKeyPair } from "../migration/signing.js";
import { listMigrations } from "../migrations/index.js";
import { buildSyntheticDatabase, FakeDocker, type FakeDockerOptions } from "./migration-env-fixtures.js";
import {
  buildSyntheticBundle,
  cleanupTempDirs,
  makeFacts,
  sourceBody,
  TEST_PASSPHRASE,
  VOLUME_NAME,
  APP_NAME
} from "./migration-fixtures.js";
import type { PlatformFacts } from "../migration/facts.js";

after(cleanupTempDirs);

const MAX_SCHEMA = Math.max(...listMigrations().map((migration) => migration.version));
const checkOf = (report: VerificationReport, id: string) => report.checks.find((check) => check.id === id);

async function destination(facts: PlatformFacts = makeFacts({ apps: [], credentialProviders: [], globalEnv: [], databaseConnections: [] }), options?: FakeDockerOptions) {
  const db = buildSyntheticDatabase(facts);

  return describeServer({
    docker: createDockerProbe(new FakeDocker(facts, options)),
    facts: readPlatformFacts(db.path),
    platformVersion: "1.9.0",
    maxSchemaVersion: MAX_SCHEMA,
    encryption: { available: true, key: db.key },
    diskPath: null
  });
}

const fingerprintOfDirectory = (directory: string): string => {
  const hash = createHash("sha256");
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        hash.update(full).update(readFileSync(full));
      }
    }
  };
  walk(directory);

  return hash.digest("hex");
};

describe("destination preflight: verifying a bundle", () => {
  test("a good unsigned bundle on a clean destination: ready with honest warnings, no failures", async () => {
    const bundle = await buildSyntheticBundle();
    const report = await runDestinationPreflight({
      descriptor: await destination(),
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE }
    });

    assert.equal(report.verdict, "ready-with-warnings");
    assert.equal(report.summary.fail, 0);
    assert.equal(checkOf(report, "bundle.integrity")?.status, "pass");
    assert.equal(checkOf(report, "bundle.authenticity")?.status, "warn"); // origin not established
    assert.match(checkOf(report, "bundle.authenticity")!.detail, /NOT established/);
    assert.equal(checkOf(report, "bundle.consistency")?.status, "warn"); // rehearsal-grade
    assert.match(checkOf(report, "bundle.consistency")!.detail, /rehearsal bundle/);
    assert.equal(checkOf(report, "destination.import.available")?.status, "warn");
    assert.equal(checkOf(report, "destination.plan")?.status, "pass");
    assert.equal(report.integrity?.status, "verified");
    assert.equal(report.authenticity?.status, "passphrase-only");
  });

  test("a pinned signer and deep verification yield pass/pass", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const report = await runDestinationPreflight({
      descriptor: await destination(),
      bundle: {
        directory: bundle.directory,
        passphrase: TEST_PASSPHRASE,
        deep: true,
        expectedSignerFingerprint: bundle.signer!.fingerprint
      }
    });

    assert.equal(checkOf(report, "bundle.integrity")?.status, "pass");
    assert.match(checkOf(report, "bundle.integrity")!.detail, /deep/);
    assert.equal(checkOf(report, "bundle.authenticity")?.status, "pass");
    assert.equal(report.authenticity?.status, "origin-verified");
  });

  test("a different pinned signer blocks the bundle even though its data is intact", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const report = await runDestinationPreflight({
      descriptor: await destination(),
      bundle: {
        directory: bundle.directory,
        passphrase: TEST_PASSPHRASE,
        deep: true,
        expectedSignerFingerprint: fingerprintOf(generateSigningKeyPair().publicKeyDer)
      }
    });

    assert.equal(report.verdict, "blocked");
    assert.equal(checkOf(report, "bundle.integrity")?.status, "pass");
    assert.equal(checkOf(report, "bundle.authenticity")?.status, "fail");
  });

  test("tampered data blocks the bundle even with a valid, pinned signature", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const volume = bundle.manifest.artifacts.find((artifact) => artifact.kind === "volume")!;
    const path = join(bundle.directory, "artifacts", `${volume.id}.enc`);
    const bytes = readFileSync(path);
    bytes[200] ^= 1;
    writeFileSync(path, bytes);

    const report = await runDestinationPreflight({
      descriptor: await destination(),
      bundle: {
        directory: bundle.directory,
        passphrase: TEST_PASSPHRASE,
        deep: true,
        expectedSignerFingerprint: bundle.signer!.fingerprint
      }
    });

    assert.equal(report.verdict, "blocked");
    assert.equal(checkOf(report, "bundle.integrity")?.status, "fail");
    assert.equal(checkOf(report, "bundle.authenticity")?.status, "pass"); // the two are independent
    assert.equal(report.authenticity?.status, "origin-verified");
  });

  test("a wrong passphrase blocks and skips everything that depends on the manifest", async () => {
    const bundle = await buildSyntheticBundle();
    const report = await runDestinationPreflight({
      descriptor: await destination(),
      bundle: { directory: bundle.directory, passphrase: "a completely different passphrase" }
    });

    assert.equal(report.verdict, "blocked");
    assert.match(checkOf(report, "bundle.integrity")!.detail, /passphrase is wrong/);
    assert.equal(checkOf(report, "bundle.authenticity")?.status, "skip");
    assert.equal(checkOf(report, "destination.plan"), undefined);
  });

  test("verification never modifies the bundle", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const before = fingerprintOfDirectory(bundle.directory);

    await runDestinationPreflight({
      descriptor: await destination(),
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE, deep: true }
    });

    assert.equal(fingerprintOfDirectory(bundle.directory), before);
  });
});

describe("destination preflight: compatibility and capacity", () => {
  test("a bundle from a newer schema is refused", async () => {
    const bundle = await buildSyntheticBundle({
      body: sourceBody({ source: { serverId: "s", platformVersion: "1.9.0", schemaVersion: MAX_SCHEMA + 3, arch: "x64" } })
    });
    const report = await runDestinationPreflight({
      descriptor: await destination(),
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE }
    });

    assert.equal(report.verdict, "blocked");
    assert.equal(checkOf(report, "destination.compatibility.schema-newer-than-target")?.status, "fail");
  });

  test("not enough disk space blocks", async () => {
    const bundle = await buildSyntheticBundle();
    const descriptor = await destination();
    descriptor.server.freeDiskBytes = 1024;
    const report = await runDestinationPreflight({
      descriptor,
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE }
    });

    assert.equal(checkOf(report, "destination.resources.disk")?.status, "fail");
    assert.equal(report.verdict, "blocked");
  });

  test("a full-server import refuses a destination that already runs apps", async () => {
    const bundle = await buildSyntheticBundle();
    const report = await runDestinationPreflight({
      descriptor: await destination(makeFacts()),
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE }
    });

    assert.equal(report.verdict, "blocked");
    assert.equal(checkOf(report, "destination.platform.empty")?.status, "fail");
    assert.equal(checkOf(report, "destination.plan")?.status, "fail");
  });
});

describe("destination preflight: nothing existing is overwritten", () => {
  const migrationOf = async () => {
    const bundle = await buildSyntheticBundle({ scope: "application", body: { transfer: { migrationId: "33333333-3333-4333-8333-333333333333", operation: "copy", epoch: 0, previousBundleId: null } } });
    const volume = bundle.manifest.artifacts.find((artifact) => artifact.kind === "volume")!;

    return { bundle, volume, migrationId: bundle.manifest.transfer.migrationId };
  };

  test("an unlabelled volume with the same name is a conflict, never overwritten", async () => {
    const { bundle } = await migrationOf();
    const report = await runDestinationPreflight({
      descriptor: await destination(undefined, { extraVolumes: [{ name: VOLUME_NAME }] }),
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE }
    });

    assert.equal(checkOf(report, "destination.conflicts.volume")?.status, "fail");
    assert.equal(checkOf(report, "destination.plan")?.status, "fail");
    assert.match(checkOf(report, "destination.plan")!.detail, new RegExp(VOLUME_NAME));
    assert.match(checkOf(report, "destination.plan")!.detail, /will not be overwritten/);
  });

  test("a volume labelled by THIS migration is ours: resumed, not a conflict", async () => {
    const { bundle, volume, migrationId } = await migrationOf();
    const report = await runDestinationPreflight({
      descriptor: await destination(undefined, {
        extraVolumes: [{ name: VOLUME_NAME, labels: { [LABEL_MIGRATION_ID]: migrationId, [LABEL_ARTIFACT_SHA256]: volume.plaintextSha256 } }]
      }),
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE }
    });

    assert.equal(checkOf(report, "destination.conflicts.volume")?.status, "pass");
    assert.equal(checkOf(report, "destination.plan")?.status, "pass");
    assert.match(checkOf(report, "destination.plan")!.detail, /1 to resume/);
  });

  test("a volume labelled by a DIFFERENT migration is a conflict", async () => {
    const { bundle, volume } = await migrationOf();
    const report = await runDestinationPreflight({
      descriptor: await destination(undefined, {
        extraVolumes: [
          {
            name: VOLUME_NAME,
            labels: { [LABEL_MIGRATION_ID]: "99999999-9999-4999-8999-999999999999", [LABEL_ARTIFACT_SHA256]: volume.plaintextSha256 }
          }
        ]
      }),
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE }
    });

    assert.equal(checkOf(report, "destination.plan")?.status, "fail");
  });

  test("colliding container names and domains are reported separately", async () => {
    const { bundle } = await migrationOf();
    const descriptor = await destination(undefined, { extraContainers: [{ name: `app-${APP_NAME}` }] });
    descriptor.inventory.domains.push(`${APP_NAME}.example.test`);
    const report = await runDestinationPreflight({
      descriptor,
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE }
    });

    assert.equal(checkOf(report, "destination.conflicts.container-name")?.status, "fail");
    assert.equal(checkOf(report, "destination.conflicts.domain")?.status, "fail");
  });
});

describe("destination preflight: consistency recorded in the bundle", () => {
  test("a cutover bundle holding an unverified database volume is blocked unless the risk was accepted", async () => {
    const rejected = await buildSyntheticBundle({
      body: { consistency: { mode: "cutover", overall: "quiesced-unverified", acceptedRisks: [] } }
    });
    const blocked = await runDestinationPreflight({
      descriptor: await destination(),
      bundle: { directory: rejected.directory, passphrase: TEST_PASSPHRASE }
    });
    assert.equal(checkOf(blocked, "bundle.consistency")?.status, "fail");
    assert.match(checkOf(blocked, "bundle.consistency")!.detail, /quiesced-unverified/);

    const accepted = await buildSyntheticBundle({
      body: {
        consistency: {
          mode: "cutover",
          overall: "quiesced-unverified",
          acceptedRisks: [{ subject: "app:1", level: "quiesced-unverified", acceptedAt: "2026-01-01T00:00:00Z", reason: "synthetic test" }]
        }
      }
    });
    const allowed = await runDestinationPreflight({
      descriptor: await destination(),
      bundle: { directory: accepted.directory, passphrase: TEST_PASSPHRASE }
    });
    assert.equal(checkOf(allowed, "bundle.consistency")?.status, "warn");
    assert.match(checkOf(allowed, "bundle.consistency")!.detail, /explicitly accepted/);
  });

  test("a live copy can never be accepted in a cutover bundle", async () => {
    const bundle = await buildSyntheticBundle({
      volumeConsistency: { level: "inconsistent", strategy: "live", evidence: [] },
      body: {
        consistency: {
          mode: "cutover",
          overall: "inconsistent",
          acceptedRisks: [{ subject: "app:1", level: "inconsistent", acceptedAt: "2026-01-01T00:00:00Z" }]
        }
      }
    });
    const report = await runDestinationPreflight({
      descriptor: await destination(),
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE }
    });

    assert.equal(checkOf(report, "bundle.consistency")?.status, "fail");
    assert.match(checkOf(report, "bundle.consistency")!.detail, /no quiesce/);
  });

  test("application-level evidence passes cleanly", async () => {
    const bundle = await buildSyntheticBundle({
      volumeConsistency: { level: "application-consistent", strategy: "hook", evidence: [{ kind: "logical-dump-verified", detail: "pg_restore --list ok" }] },
      body: { consistency: { mode: "cutover", overall: "application-consistent", acceptedRisks: [] } }
    });
    const report = await runDestinationPreflight({
      descriptor: await destination(),
      bundle: { directory: bundle.directory, passphrase: TEST_PASSPHRASE }
    });

    assert.equal(checkOf(report, "bundle.consistency")?.status, "pass");
  });
});
