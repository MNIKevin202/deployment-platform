import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { verifyBundle } from "../migration/bundle.js";
import { buildExportReport, ExportRefusedError } from "../migration/export.js";
import { readJournals } from "../migration/export-journal.js";
import { renderReportText } from "../migration/report.js";
import { fingerprintOf, generateSigningKeyPair } from "../migration/signing.js";
import { GITHUB_TOKEN } from "./migration-env-fixtures.js";
import { noSleep, makeHarness, openBundle, PG_DUMP, WEB_INDEX } from "./export-harness.js";
import { cleanupTempDirs, PLANTED_SECRET, TEST_PASSPHRASE } from "./migration-fixtures.js";

after(cleanupTempDirs);

const mutating = (calls: string[]): string[] => calls.filter((call) => /^(stop|start|pause|unpause):/.test(call));
const volumeCalls = (calls: string[]): string[] => calls.filter((call) => call.startsWith("volumeArchive:"));

describe("rehearsal export: nothing is disturbed", () => {
  test("a verified dump for the database, a live copy for the rest, and no app is stopped or paused", async () => {
    const h = await makeHarness();
    const result = await h.run({ scope: "application", operation: "copy", appId: 1, selection: [2, 3], mode: "rehearsal" });

    assert.deepEqual(mutating(h.fake.calls), [], "a rehearsal must not stop or pause anything");
    assert.deepEqual(result.disruptions, []);

    const db = result.apps.find((app) => app.name === "db")!;
    assert.equal(db.strategy, "hook");
    assert.equal(db.volumes[0]!.level, "application-consistent");
    assert.equal(db.volumes[0]!.artifactKind, "db-dump");
    assert.match(db.volumes[0]!.evidence[0]!.detail!, /completion marker present/);

    const web = result.apps.find((app) => app.name === "web")!;
    assert.equal(web.volumes[0]!.level, "inconsistent");
    assert.deepEqual(web.volumes[0]!.evidence, []);
    assert.equal(result.overallConsistency, "inconsistent");
  });

  test("the bundle really contains the data: dump, volume files, definitions, images", async () => {
    const h = await makeHarness();
    const result = await h.run({ scope: "application", operation: "copy", appId: 1, selection: [2, 3] });
    const bundle = await openBundle(result.bundlePath);

    assert.equal((await bundle.artifact("db-dump", "app:2")).toString(), PG_DUMP);

    const web = await bundle.files("volume", "app:1");
    assert.equal(web["./index.html"]!.toString(), WEB_INDEX);
    assert.equal(web["./big.bin"]!.length, 200_000);

    const definition = JSON.parse((await bundle.artifact("app-definition", "app:1")).toString());
    assert.equal(definition.app.name, "web");
    assert.ok(definition.environment.some((row: { key: string; value: string }) => row.key === "DATABASE_URL" && row.value.includes(PLANTED_SECRET)));
    assert.equal(definition.credentials[0].provider, "github");
    assert.equal(definition.credentials[0].secret, GITHUB_TOKEN, "credentials are decrypted so the destination can re-encrypt them");
    assert.deepEqual(definition.dependencies.strong, ["app:2"]);
    assert.equal(definition.cronJobs.length, 2);

    assert.deepEqual(bundle.artifacts("image").map((a) => a.meta.tag).sort(), ["deployment-app-1:000111222333", "deployment-app-1:abc123def456"]);
    assert.ok(typeof bundle.artifacts("image")[0]!.meta.imageId === "string");
    assert.equal((await bundle.artifact("image", "app:1")).length, 150_000);

    // The manifest records it all, and is consistent with the Phase 0 format.
    assert.equal(bundle.manifest.scope, "application");
    assert.deepEqual(bundle.manifest.apps.map((app) => app.name), ["web", "db", "worker"]);
    assert.equal(bundle.manifest.apps.find((a) => a.name === "db")!.volumes[0]!.artifactId, bundle.artifacts("db-dump")[0]!.id);
    assert.equal(bundle.manifest.apps.find((a) => a.name === "web")!.dormantOnImport, true); // a copy imports dormant
    assert.deepEqual(bundle.manifest.apps.find((a) => a.name === "web")!.dependsOn, ["app:2"]);
  });

  test("the whole bundle is encrypted: no secret, app name or data is recoverable from any file", async () => {
    const h = await makeHarness();
    const result = await h.run({ scope: "application", operation: "copy", appId: 1, selection: [2, 3] });
    const needles = [PLANTED_SECRET, GITHUB_TOKEN, "synthetic web volume", "PostgreSQL database cluster dump", "synthetic-pg-password", "web-uploads", "db-data", "app-web"];

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
    for (const file of walk(result.bundlePath)) {
      const content = readFileSync(file).toString("latin1");
      for (const needle of needles) {
        assert.ok(!content.includes(needle), `${file} leaks "${needle}"`);
      }
    }
  });

  test("the finished bundle passes deep verification and is only readable with the passphrase", async () => {
    const h = await makeHarness();
    const result = await h.run({ scope: "application", operation: "backup", appId: 4 });

    assert.equal(result.verification?.integrity.status, "verified");
    assert.equal(result.verification?.integrity.depth, "deep");
    assert.equal((await verifyBundle(result.bundlePath, "a completely different passphrase")).integrity.problems[0]?.code, "WRONG_PASSPHRASE");
  });
});

describe("cutover export: evidence or nothing", () => {
  const accept = { web: "quiesced-unverified" as const };

  test("a stop is journaled first, happens, is restored — and is recorded as quiesced-UNVERIFIED, never consistent", async () => {
    const h = await makeHarness();
    const stoppedDuringStream: boolean[] = [];
    let journalOnDiskBeforeStop = false;
    h.fake.onCall = async (op, target) => {
      if (op === "stop") {
        const journals = await readJournals(h.stateDir);
        journalOnDiskBeforeStop = journals.some((j) => j.entries.some((e) => e.containerName === "app-web" && e.state === "intent"));
      }
      if (op === "volumeArchive" && target === "web-uploads") {
        stoppedDuringStream.push(!h.fake.state("app-web").running);
      }
    };
    const result = await h.run({ scope: "application", operation: "move", appId: 1, selection: [2, 3], mode: "cutover", acceptRisks: accept });

    assert.equal(journalOnDiskBeforeStop, true, "the recovery journal must be durable before the app is touched");
    assert.deepEqual(stoppedDuringStream, [true], "the app must be stopped while its volume is read");
    assert.equal(h.fake.state("app-web").running, true, "and running again afterwards");
    assert.equal(result.disruptions.length, 1);
    assert.equal(result.disruptions[0]!.app, "app-web");

    const web = result.apps.find((a) => a.name === "web")!.volumes[0]!;
    assert.equal(web.level, "quiesced-unverified");
    assert.deepEqual(web.evidence.map((e) => e.kind), ["clean-exit"]);
    assert.notEqual(web.level, "application-consistent");

    const bundle = await openBundle(result.bundlePath);
    assert.equal(bundle.manifest.consistency.mode, "cutover");
    assert.deepEqual(bundle.manifest.consistency.acceptedRisks.map((r) => [r.subject, r.level]), [["app:1", "quiesced-unverified"]]);
    assert.equal(bundle.manifest.consistency.overall, "quiesced-unverified");
    assert.equal(bundle.manifest.apps.find((a) => a.name === "web")!.dormantOnImport, false); // a move is not dormant
  });

  test("without an explicit acceptance, cutover is refused BEFORE anything is stopped", async () => {
    const h = await makeHarness();
    const plan = await h.plan({ scope: "application", operation: "move", appId: 1, selection: [2, 3], mode: "cutover" });

    assert.ok(plan.refusals.some((r) => r.code === "consistency-evidence-required"));
    await assert.rejects(h.run({}, { plan }), ExportRefusedError);
    assert.deepEqual(mutating(h.fake.calls), []);
    assert.deepEqual(volumeCalls(h.fake.calls), []);
    assert.deepEqual(readdirSync(h.outputDir), [], "no bundle directory was even created");
  });

  test("a forced kill is recorded as crash-consistent, not as a clean stop", async () => {
    const h = await makeHarness();
    h.fake.addContainer({ name: "app-web", exitCodeOnStop: 137, mounts: [{ type: "volume", name: "web-uploads", destination: "/uploads" }] });
    const result = await h.run({ scope: "application", operation: "move", appId: 1, selection: [2, 3], mode: "cutover", acceptRisks: { web: "crash-consistent" } });
    const web = result.apps.find((a) => a.name === "web")!.volumes[0]!;

    assert.equal(web.level, "crash-consistent");
    assert.deepEqual(web.evidence.map((e) => e.kind), ["forced-kill"]);
  });

  test("PostgreSQL stopped with a verified clean shutdown IS application-consistent — the database's own statement", async () => {
    const h = await makeHarness();
    const result = await h.run({
      scope: "application", operation: "backup", appId: 2, mode: "cutover",
      strategies: { default: "auto", perApp: { db: "stop" } }
    });
    const volume = result.apps.find((a) => a.name === "db")!.volumes[0]!;

    assert.equal(volume.level, "application-consistent");
    assert.deepEqual(volume.evidence.map((e) => e.kind), ["clean-exit", "clean-shutdown-marker-verified"]);
    assert.match(volume.evidence[1]!.detail!, /"shut down"/);
    assert.equal(volume.artifactKind, "volume"); // raw files, proven consistent
    assert.equal(h.fake.state("app-db").running, true);
  });

  test("a PostgreSQL that did NOT shut down cleanly is not claimed consistent: the gate aborts and the app is restored", async () => {
    const h = await makeHarness({ pgControldata: "Database cluster state:               in production\n" });
    const plan = await h.plan({ scope: "application", operation: "backup", appId: 2, mode: "cutover", strategies: { default: "auto", perApp: { db: "stop" } } });
    assert.deepEqual(plan.refusals, []); // conditional: it may well have been fine

    await assert.rejects(h.run({}, { plan }), (error: Error) => error.name === "ExportFailedError" && /quiesced-unverified/.test(error.message));
    assert.equal(h.fake.state("app-db").running, true);
    assert.deepEqual(readdirSync(h.outputDir), []);
    assert.ok(h.logs.some((l) => /Restoring "db"/.test(l)));
  });

  test("group mode stops dependents first and restores dependencies first, around ONE snapshot window", async () => {
    const h = await makeHarness();
    const order: string[] = [];
    h.fake.onCall = (op, target) => {
      if (["stop", "start"].includes(op)) {
        order.push(`${op}:${target.replace("id-", "")}`);
      }
    };
    await h.run({
      scope: "application", operation: "move", appId: 1, selection: [2, 3], mode: "cutover", quiesce: "group",
      strategies: { default: "stop", perApp: {} }, acceptRisks: { web: "quiesced-unverified", db: "quiesced-unverified" }
    });

    // worker is stateless (never stopped); web uses db, so web stops first and comes back last.
    assert.deepEqual(order.filter((entry) => entry.startsWith("stop:")), ["stop:app-web", "stop:app-db"]);
    assert.deepEqual(order.filter((entry) => entry.startsWith("start:")), ["start:app-db", "start:app-web"]);
  });

  test("an app is down ONLY while its own window runs: it is restarted before the export moves on", async () => {
    const stop = { strategies: { default: "stop" as const, perApp: {} }, acceptRisks: { web: "quiesced-unverified" as const, db: "quiesced-unverified" as const } };
    const sequential = await makeHarness();
    const events: string[] = [];
    sequential.fake.onCall = (op, target) => {
      if (op === "stop" || op === "start") {
        events.push(`${op}:${target.replace("id-", "")}`);
      }
    };
    await sequential.run(
      { scope: "application", operation: "move", appId: 1, selection: [2, 3], mode: "cutover", quiesce: "sequential", ...stop },
      { run: { onStep: (step) => void events.push(`step:${step}`) } }
    );

    const at = (event: string): number => events.indexOf(event);
    assert.ok(at("start:app-web") > at("stop:app-web"), "web is stopped, then restarted");
    assert.ok(at("start:app-web") < at("stop:app-db"), "web is back up BEFORE db's window begins");
    assert.ok(at("start:app-db") < at("step:finalize"), "db is back up before the bundle is finalized");

    // One group window: everything is back before the (slow) finalization and deep verification.
    const group = await makeHarness();
    const groupEvents: string[] = [];
    group.fake.onCall = (op, target) => {
      if (op === "start") {
        groupEvents.push(`start:${target.replace("id-", "")}`);
      }
    };
    await group.run(
      { scope: "application", operation: "move", appId: 1, selection: [2, 3], mode: "cutover", quiesce: "group", ...stop },
      { run: { onStep: (step) => void groupEvents.push(`step:${step}`) } }
    );
    const finalizeAt = groupEvents.indexOf("step:finalize");
    assert.ok(finalizeAt > 0);
    assert.ok(groupEvents.indexOf("start:app-web") < finalizeAt && groupEvents.indexOf("start:app-db") < finalizeAt, "no app stays down while the bundle is finalized or verified");
  });

  test("stateless apps are never disturbed", async () => {
    const h = await makeHarness();
    await h.run({ scope: "application", operation: "backup", appId: 4, mode: "cutover" });

    assert.deepEqual(mutating(h.fake.calls), []);
  });
});

describe("platform export", () => {
  test("carries the database snapshot, the configuration (with the credential key) and the proxy routes", async () => {
    const h = await makeHarness();
    const result = await h.run({ scope: "platform", operation: "backup", mode: "rehearsal" });
    const bundle = await openBundle(result.bundlePath);

    // The database: a consistent snapshot that opens and holds every app.
    const snapshot = join(h.stateDir, "..", "restored.sqlite");
    (await import("node:fs")).writeFileSync(snapshot, await bundle.artifact("platform-database"));
    const db = new DatabaseSync(snapshot, { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM apps").get() as { n: number }).n, 4);
      assert.equal((db.prepare("PRAGMA integrity_check").get() as Record<string, string>).integrity_check, "ok");
    } finally {
      db.close();
    }
    const dbMeta = bundle.artifacts("platform-database")[0]!.meta;
    assert.equal(dbMeta.consistency, "application-consistent");
    assert.match(String(dbMeta.evidence), /integrity_check/);

    const config = await bundle.files("platform-config");
    assert.match(config["auth.env"]!.toString(), /CREDENTIAL_ENCRYPTION_KEY=SYNTHETIC-ENV-KEY-VALUE/);
    assert.ok(config["trusted-keys/release.pem"]);
    assert.match((await bundle.files("caddy-routes"))["web.caddy"]!.toString(), /reverse_proxy/);

    assert.equal(bundle.manifest.scope, "platform");
    assert.equal(bundle.manifest.apps.length, 4);
    assert.ok(!bundle.artifacts("app-definition").length, "at platform scope the database carries the definitions");
    assert.deepEqual(readdirSync(h.stateDir).filter((n) => n.startsWith("snap-")), [], "the temporary database snapshot is removed");
  });

  test("the snapshot is taken from a read-only handle: the live database file is unchanged", async () => {
    const h = await makeHarness();
    const before = readFileSync(h.dbPath);
    await h.run({ scope: "platform", operation: "backup" });

    assert.ok(readFileSync(h.dbPath).equals(before));
  });

  test("a missing configuration directory is refused up front", async () => {
    const h = await makeHarness();
    const plan = await h.plan({ scope: "platform" });
    plan.refusals.push({ code: "config-unavailable", message: "x", remedy: "y" });

    await assert.rejects(h.run({}, { plan }), ExportRefusedError);
    assert.deepEqual(mutating(h.fake.calls), []);
  });
});

describe("signing and reporting", () => {
  test("a signed bundle verifies against its pinned signer; an unsigned one says so", async () => {
    const h = await makeHarness();
    const signer = generateSigningKeyPair();
    const signed = await h.run({ scope: "application", operation: "backup", appId: 4 }, { signingKeyPem: signer.privateKeyPem, run: { bundleName: "signed" } });
    const fingerprint = fingerprintOf(signer.publicKeyDer);

    assert.equal(signed.signerFingerprint, fingerprint);
    assert.equal(signed.verification?.authenticity.status, "origin-verified");
    assert.equal((await verifyBundle(signed.bundlePath, TEST_PASSPHRASE, { expectedSignerFingerprint: fingerprint })).authenticity.status, "origin-verified");

    const unsigned = await h.run({ scope: "application", operation: "backup", appId: 4 }, { run: { bundleName: "unsigned" } });
    assert.equal(unsigned.signerFingerprint, null);
    assert.equal(unsigned.verification?.authenticity.status, "passphrase-only");
  });

  test("the report states evidence, disruption and what was NOT exported — and leaks nothing", async () => {
    const h = await makeHarness();
    h.fake.addContainer({
      name: "app-web",
      mounts: [{ type: "volume", name: "web-uploads", destination: "/uploads" }, { type: "bind", source: "/srv/secret-host-path", destination: "/host-data" }]
    });
    const result = await h.run({ scope: "application", operation: "copy", appId: 1, selection: [2, 3] });
    const report = buildExportReport(result);
    const text = renderReportText(report);
    const json = JSON.stringify(report);

    assert.equal(report.kind, "export");
    assert.match(text, /Encrypted bundle written/);
    assert.match(text, /No application was stopped or paused/);
    assert.match(text, /db: db-data[^\n]*\n[^\n]*application-consistent via hook — evidence: logical-dump-verified/);
    assert.match(text, /web: web-uploads[^\n]*\n[^\n]*inconsistent via live — no evidence beyond the strategy itself/);
    assert.match(text, /not exported \(bind-mount\)/);
    assert.match(text, /NOT signed/);
    for (const needle of [PLANTED_SECRET, GITHUB_TOKEN, TEST_PASSPHRASE, "/srv/secret-host-path", h.key.toString("base64")]) {
      assert.ok(!json.includes(needle) && !text.includes(needle), `report leaks ${needle.slice(0, 12)}…`);
    }
  });
});

describe("clean up after success", () => {
  test("no journal, no helper container and no stray file is left behind", async () => {
    const h = await makeHarness();
    const result = await h.run({ scope: "application", operation: "copy", appId: 1, selection: [2, 3] });

    assert.deepEqual(await readJournals(h.stateDir), []);
    assert.deepEqual(readdirSync(h.stateDir), []);
    assert.equal(h.fake.helpersOpen, 0);
    assert.equal(h.fake.helpersCreated, 1); // web-uploads; the dump needed no helper
    assert.deepEqual(readdirSync(h.outputDir), [result.bundlePath.split(/[\\/]/).pop()]);
    assert.ok(existsSync(join(result.bundlePath, "manifest.enc")));
    void noSleep;
  });

  test("a bundle name cannot point outside the output directory (a failed export deletes its directory)", async () => {
    const h = await makeHarness();
    const plan = await h.plan({ scope: "application", operation: "backup", appId: 4 });

    for (const name of ["../escape", "..", ".hidden", "a/b", "a\\b", "-flag", "", "x".repeat(101), "C:evil"]) {
      const callsBefore = h.fake.calls.length;
      await assert.rejects(h.run({}, { plan, run: { bundleName: name } }), /bundle name may contain only/, JSON.stringify(name));
      assert.equal(h.fake.calls.length, callsBefore, "refused before any Docker call");
    }
    assert.deepEqual(readdirSync(h.outputDir), []);
    await h.run({}, { plan, run: { bundleName: "ok-name_1.2" } });
  });

  test("an existing destination path is never written over", async () => {
    const h = await makeHarness();
    await h.run({ scope: "application", operation: "backup", appId: 4 }, { run: { bundleName: "dup" } });

    await assert.rejects(h.run({ scope: "application", operation: "backup", appId: 4 }, { run: { bundleName: "dup" } }), /existing path/);
  });
});
