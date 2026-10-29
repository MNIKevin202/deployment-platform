import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { runSourcePreflight } from "../migration/preflight.js";
import { createDockerProbe, readOnlyClientFrom } from "../migration/probes.js";
import { ExportFailedError } from "../migration/export.js";
import { JournalStore, readJournals, recoverDisruptions } from "../migration/export-journal.js";
import { DisruptionGuard } from "../migration/quiesce.js";
import { presetFor, verifyDump } from "../migration/hooks.js";
import { listMigrations } from "../migrations/index.js";
import { verifyBundle } from "../migration/bundle.js";
import { createExportDockerClient } from "../migration/export-docker.js";
import { openBundle } from "./export-harness.js";
import { untar } from "./export-fakes.js";
import {
  cleanupEstate, createEstate, DEBIAN_IMAGE, dockerAvailable, execOut, ITEST_LABEL, leftoverHelpers, MARKER,
  makeRealHarness, names, newDocker, ourHelperIds, seedPostgres, snapshotOurs, sleep, waitFor, waitForPostgres
} from "./real-docker-estate.js";
import { cleanupTempDirs, makeTempDir, TEST_PASSPHRASE } from "./migration-fixtures.js";

/**
 * Integration tests against a REAL Docker daemon (Linux engine) with a REAL PostgreSQL.
 *
 * Opt-in: set CF_DOCKER_TESTS=1. They use only images already present locally
 * (postgres:16-alpine, debian:bookworm-slim) and never pull. Everything they create is
 * labelled `cfmig-itest=<runId>` and removed afterwards; nothing else on the daemon is touched.
 */

const enabled = process.env.CF_DOCKER_TESTS === "1" && (await dockerAvailable());
const MAX_SCHEMA = Math.max(...listMigrations().map((m) => m.version));
const docker = newDocker();
const client = createExportDockerClient(docker);
const startedAt = async (name: string): Promise<string> => (await docker.getContainer(name).inspect()).State.StartedAt;
const state = async (name: string) => {
  const s = (await docker.getContainer(name).inspect()).State;

  return { running: s.Running, paused: s.Paused, exitCode: s.ExitCode };
};

after(cleanupTempDirs);

describe("real Docker: read-only inspection changes nothing", { skip: !enabled }, () => {
  const runId = randomBytes(4).toString("hex");
  before(() => createEstate(runId));
  after(() => cleanupEstate(runId));

  test("Phase 0's read-only probe and preflight, against a live daemon, leave every container and volume exactly as they were", async () => {
    const h = makeRealHarness(runId, makeTempDir("cfmig-real-"));
    const before = await snapshotOurs(runId);
    const startedBefore = [await startedAt(names(runId).pgContainer), await startedAt(names(runId).webContainer)];

    const report = await runSourcePreflight({
      scope: "platform",
      operation: "backup",
      facts: h.facts,
      docker: createDockerProbe(readOnlyClientFrom(docker)),
      encryption: { available: true, key: Buffer.alloc(32, 1) },
      platformVersion: "1.9.0",
      maxKnownSchemaVersion: MAX_SCHEMA
    });

    const check = (id: string, subject?: string) => report.checks.find((c) => c.id === id && (subject === undefined || c.subject === subject));
    assert.equal(check("source.docker.reachable")?.status, "pass");
    assert.equal(check("source.app.runtime", "app:1")?.status, "pass", "the real postgres container is seen as running");
    assert.equal(check("source.app.volumes", "app:2")?.status, "pass", "the real volume is found");
    assert.deepEqual(await snapshotOurs(runId), before, "no container or volume was created, changed or removed");
    assert.deepEqual([await startedAt(names(runId).pgContainer), await startedAt(names(runId).webContainer)], startedBefore, "nothing was restarted");
  });
});

describe("real Docker: a REAL PostgreSQL dump is verified by its own completion marker", { skip: !enabled }, () => {
  const runId = randomBytes(4).toString("hex");
  before(async () => {
    await createEstate(runId);
    await waitForPostgres(client, runId);
    await seedPostgres(client, runId);
  });
  after(() => cleanupEstate(runId));

  test("the built-in hook produces a dump that verifies, and the bytes contain the row we wrote", async () => {
    const hook = presetFor("postgres")!;
    const exec = await client.exec(names(runId).pgContainer, hook.cmd, { user: hook.user });
    const chunks: Buffer[] = [];
    for await (const chunk of exec.stdout) {
      chunks.push(chunk as Buffer);
    }
    const finished = await exec.finished();
    const dump = Buffer.concat(chunks);

    const verdict = verifyDump(hook, { exitCode: finished.exitCode, bytes: dump.length, tail: dump.subarray(-4096).toString(), stderr: finished.stderr });
    assert.equal(verdict.ok, true, `${verdict.detail}\n${finished.stderr}`);
    assert.match(verdict.detail, /completion marker present/);
    assert.ok(dump.toString().includes(MARKER), "the dump contains the seeded row");
  });

  test("a TRUNCATED real dump is rejected: the marker is what proves completeness", async () => {
    const hook = presetFor("postgres")!;
    const exec = await client.exec(names(runId).pgContainer, hook.cmd);
    const chunks: Buffer[] = [];
    for await (const chunk of exec.stdout) {
      chunks.push(chunk as Buffer);
    }
    await exec.finished();
    const whole = Buffer.concat(chunks);
    const cut = whole.subarray(0, Math.floor(whole.length * 0.6)); // as if the stream died

    const verdict = verifyDump(hook, { exitCode: 0, bytes: cut.length, tail: cut.subarray(-4096).toString(), stderr: "" });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /completion marker/);
  });

  test("a full export with the hook: application-consistent, the database never restarted", async () => {
    const h = makeRealHarness(runId, makeTempDir("cfmig-real-"));
    const before = await startedAt(names(runId).pgContainer);
    const result = await h.run({ scope: "application", operation: "backup", appId: 1, mode: "cutover" });

    const volume = result.apps[0]!.volumes[0]!;
    assert.equal(volume.level, "application-consistent");
    assert.equal(volume.artifactKind, "db-dump");
    assert.deepEqual(volume.evidence.map((e) => e.kind), ["logical-dump-verified"]);
    assert.deepEqual(result.disruptions, [], "a verified dump disturbs nothing");
    assert.equal(await startedAt(names(runId).pgContainer), before, "PostgreSQL was never stopped or restarted");

    const bundle = await openBundle(result.bundlePath);
    const dump = (await bundle.artifact("db-dump", "app:1")).toString();
    assert.ok(dump.includes(MARKER) && dump.includes("PostgreSQL database cluster dump complete"));
    assert.equal((await verifyBundle(result.bundlePath, TEST_PASSPHRASE, { deep: true })).integrity.status, "verified");
    assert.equal(await leftoverHelpers(runId), 0);
  });

  test("stop strategy: a real `docker stop`, real pg_controldata says 'shut down' (application-consistent), the database comes back with its data", async () => {
    const h = makeRealHarness(runId, makeTempDir("cfmig-real-"));
    const before = await startedAt(names(runId).pgContainer);
    const result = await h.run({
      scope: "application", operation: "backup", appId: 1, mode: "cutover",
      strategies: { default: "auto", perApp: { db: "stop" } }
    });

    const volume = result.apps[0]!.volumes[0]!;
    assert.equal(volume.level, "application-consistent", JSON.stringify(volume.evidence));
    assert.deepEqual(volume.evidence.map((e) => e.kind), ["clean-exit", "clean-shutdown-marker-verified"]);
    assert.match(volume.evidence[1]!.detail!, /"shut down"/);
    assert.equal(volume.artifactKind, "volume");

    assert.notEqual(await startedAt(names(runId).pgContainer), before, "it really was restarted");
    assert.equal((await state(names(runId).pgContainer)).running, true);
    await waitForPostgres(client, runId);
    assert.ok((await execOut(client, names(runId).pgContainer, ["psql", "-U", "postgres", "-tAc", "select x from itest"])).out.includes(MARKER), "the data survived the stop/start");
    assert.equal(await leftoverHelpers(runId), 0);
  });
});

describe("real Docker: volumes, freezing and classification of stops", { skip: !enabled }, () => {
  const runId = randomBytes(4).toString("hex");
  before(() => createEstate(runId, { webMegabytes: 5, webIgnoresTerm: true }));
  after(() => cleanupEstate(runId));

  test("a volume is read through a real, read-only, network-less helper that is removed; the volume itself is untouched", async () => {
    const n = names(runId);
    const archive = await client.volumeArchive(n.webVolume, { helperImage: DEBIAN_IMAGE });

    // Read the stream FIRST: the daemon can hold a container busy while its archive is being served,
    // so inspecting the helper mid-stream is not something the exporter (or this test) should do.
    const chunks: Buffer[] = [];
    for await (const chunk of archive.stream) {
      chunks.push(chunk as Buffer);
    }

    // The helper still exists until dispose(), and is exactly what the design says: never started,
    // read-only, no network, the volume bound read-only.
    const [helperId] = await ourHelperIds(runId);
    assert.ok(helperId, "the helper exists until disposed");
    const detail = await docker.getContainer(helperId).inspect();
    assert.equal(detail.State.Running, false, "the helper is never started");
    assert.equal(detail.HostConfig.ReadonlyRootfs, true);
    assert.equal(detail.HostConfig.NetworkMode, "none");
    assert.deepEqual(detail.HostConfig.Binds, [`${n.webVolume}:/src:ro`]);
    await archive.dispose();
    const files = untar(Buffer.concat(chunks));
    const name = Object.keys(files).find((f) => f.endsWith("hello.txt"))!;
    assert.equal(files[name]!.toString(), "CFMIG-WEB-FILE\n");
    assert.equal(files[Object.keys(files).find((f) => f.endsWith("big.bin"))!]!.length, 5 * 1024 * 1024);

    assert.equal(await leftoverHelpers(runId), 0, "the helper was removed");
    assert.ok(((await docker.listVolumes()).Volumes ?? []).some((v) => v.Name === n.webVolume), "removing the helper did not remove the volume");
  });

  test("a volume that does not exist is refused and NOT created", async () => {
    const ghost = `cfmig-itest-${runId}-ghost`;

    await assert.rejects(client.volumeArchive(ghost, { helperImage: DEBIAN_IMAGE }), /does not exist; refusing to create it/);
    assert.ok(!((await docker.listVolumes()).Volumes ?? []).some((v) => v.Name === ghost), "no volume was created");
    assert.equal(await leftoverHelpers(runId), 0);
  });

  test("a real pause: the app is frozen while its volume is read, and unfrozen afterwards", async () => {
    const h = makeRealHarness(runId, makeTempDir("cfmig-real-"));
    let pausedDuringRead: boolean | undefined;
    const result = await h.run(
      { scope: "application", operation: "backup", appId: 2, mode: "rehearsal", strategies: { default: "freeze", perApp: {} } },
      { onStep: async (step) => { if (step === "volume") { pausedDuringRead = (await state(names(runId).webContainer)).paused; } } }
    );

    assert.equal(pausedDuringRead, true, "the container really was paused while its data was read");
    assert.deepEqual(await state(names(runId).webContainer), { running: true, paused: false, exitCode: 0 });
    assert.equal(result.apps[0]!.volumes[0]!.level, "crash-consistent");
    assert.deepEqual(result.apps[0]!.volumes[0]!.evidence.map((e) => e.kind), ["frozen"]);
  });

  test("a process that ignores SIGTERM is really killed by `docker stop` and classified as a forced kill — not a clean exit", async () => {
    const dir = makeTempDir("cfmig-real-");
    const journal = new JournalStore(join(dir, "state"));
    await journal.create(join(dir, "bundle"));
    const guard = new DisruptionGuard(client, journal, { graceSeconds: 1 });

    const outcome = await guard.stop({ ref: "app:2", containerName: names(runId).webContainer });
    assert.equal(outcome.exitCode, 137);
    assert.equal(outcome.forcedKill, true);
    assert.equal(outcome.cleanExit, false);
    assert.equal((await state(names(runId).webContainer)).running, false);

    assert.deepEqual((await guard.restoreAll()).failed, []);
    assert.equal((await state(names(runId).webContainer)).running, true, "restored, and verified running by the real daemon");
  });
});

describe("real Docker: interruptions", { skip: !enabled }, () => {
  const runId = randomBytes(4).toString("hex");
  before(() => createEstate(runId, { webMegabytes: 300, webIgnoresTerm: true }));
  after(() => cleanupEstate(runId));

  test("cancelling while the app is stopped and its volume is streaming: the real app is running again, no helper, no bundle, no journal", async () => {
    const h = makeRealHarness(runId, makeTempDir("cfmig-real-"));
    const controller = new AbortController();
    let sawStopped = false;
    const outcome = await h
      .run(
        { scope: "application", operation: "backup", appId: 2, mode: "cutover", strategies: { default: "stop", perApp: {} }, acceptRisks: { web: "crash-consistent" } },
        {
          signal: controller.signal,
          onStep: async (step) => {
            if (step === "volume") {
              sawStopped = !(await state(names(runId).webContainer)).running;
              setTimeout(() => controller.abort(new Error("cancelled by the operator")), 150);
            }
          }
        }
      )
      .catch((error: Error) => error);

    assert.ok(outcome instanceof ExportFailedError, String(outcome));
    assert.match(outcome.message, /cancelled by the operator/);
    assert.equal(outcome.restoreFailed, false);
    assert.equal(sawStopped, true, "the real container WAS stopped when the cancel arrived");
    assert.equal((await state(names(runId).webContainer)).running, true, "and is running again");
    assert.equal(await leftoverHelpers(runId), 0);
    assert.deepEqual(readdirSync(h.outputDir), [], "no partial bundle");
    assert.deepEqual(await readJournals(h.stateDir), [], "no journal left");
  });

  test("a REAL SIGKILL of the exporter while the real app is stopped: recovery from the on-disk journal restarts it", async () => {
    const base = makeTempDir("cfmig-real-");
    const childPath = fileURLToPath(new URL("./export-real-kill-child.ts", import.meta.url));
    const proc = spawn(process.execPath, ["--import", "tsx", childPath, runId, base], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CF_DOCKER_TESTS: "1" } });
    let output = "";
    proc.stdout!.on("data", (c: Buffer) => (output += c.toString()));
    proc.stderr!.on("data", (c: Buffer) => (output += c.toString()));

    try {
      await waitFor(async () => output.includes("APP-STOPPED") || proc.exitCode !== null, "the exporter to stop the app", 120_000);
      assert.equal(proc.exitCode, null, `the exporter exited early:\n${output}`);
      assert.equal(proc.kill("SIGKILL"), true);
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    }

    // The wreckage, observed on the REAL daemon.
    const web = names(runId).webContainer;
    assert.equal((await state(web)).running, false, "the killed exporter left the real app STOPPED");
    const stateDir = join(base, "state");
    const journals = await readJournals(stateDir);
    assert.equal(journals.length, 1, "the journal survived the kill");
    assert.ok(journals[0]!.entries.some((e) => e.containerName === web && e.wasRunning && e.state !== "restored"));

    const results = await recoverDisruptions(client, stateDir, { force: true, verifyMs: 30_000 });
    assert.deepEqual(results[0]!.failed, []);
    assert.ok(results[0]!.restored.includes(web));
    assert.equal((await state(web)).running, true, "recovery restarted the real app");
    assert.equal(await leftoverHelpers(runId), 0, "any helper the dead exporter left was swept");
    assert.deepEqual(await readJournals(stateDir), []);
    assert.ok(!existsSync(journals[0]!.bundlePath), "the unfinished bundle was removed");
    void sleep;
  });
});

describe("real Docker: the test suite cleans up after itself", { skip: !enabled }, () => {
  test("no resource labelled by these tests remains once their estates are gone", async () => {
    // Every earlier describe block has finished and run its cleanup; this block runs last.
    const strayContainers = await docker.listContainers({ all: true, filters: { label: [ITEST_LABEL] } });
    const strayVolumes = (await docker.listVolumes({ filters: { label: [ITEST_LABEL] } })).Volumes ?? [];
    const strayHelpers = await docker.listContainers({ all: true, filters: { label: ["com.deployment-platform.migration-tool=export-helper"] } });

    assert.deepEqual(strayContainers.map((c) => c.Names[0]), []);
    assert.deepEqual(strayVolumes.map((v) => v.Name), []);
    assert.deepEqual(strayHelpers.map((c) => c.Names[0]), []);
  });
});
