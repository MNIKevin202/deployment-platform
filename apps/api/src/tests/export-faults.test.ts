import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, describe, test } from "node:test";
import { ExportBusyError, ExportFailedError, type ExportResult } from "../migration/export.js";
import { readJournals, recoverDisruptions } from "../migration/export-journal.js";
import type { ExportOptions } from "../migration/export-plan.js";
import { verifyBundle } from "../migration/bundle.js";
import { makeHarness, noSleep, type Harness } from "./export-harness.js";
import { cleanupTempDirs, TEST_PASSPHRASE } from "./migration-fixtures.js";

after(cleanupTempDirs);

/** A cutover export that STOPS apps: the most disruptive configuration. */
const STOP: Partial<ExportOptions> = {
  scope: "application", operation: "move", appId: 1, selection: [2, 3], mode: "cutover",
  strategies: { default: "stop", perApp: {} },
  acceptRisks: { web: "quiesced-unverified", db: "quiesced-unverified" }
};
/** Pauses apps instead of stopping them. */
const FREEZE: Partial<ExportOptions> = {
  scope: "application", operation: "copy", appId: 1, selection: [2, 3], mode: "rehearsal",
  strategies: { default: "freeze", perApp: {} }
};
/** No disruption at all: a verified dump, a live copy and images. */
const REHEARSAL: Partial<ExportOptions> = { scope: "application", operation: "copy", appId: 1, selection: [2, 3], mode: "rehearsal" };
/** Everything: database snapshot, config, routes, volumes, images. */
const PLATFORM: Partial<ExportOptions> = { scope: "platform", operation: "backup", mode: "rehearsal" };

const APPS = ["app-web", "app-db", "app-worker", "app-static"];

/**
 * THE invariants. After ANY export — successful, failed, faulted or cancelled — the
 * installation must be exactly as it was: every app running, nothing left running
 * on the host that the export created, and no half-written bundle.
 */
async function assertInstallationIntact(h: Harness, outcome: ExportResult | ExportFailedError | Error, label: string): Promise<void> {
  for (const name of APPS) {
    const state = h.fake.state(name);
    assert.equal(state.running, true, `${label}: ${name} was left stopped`);
    assert.equal(state.paused, false, `${label}: ${name} was left paused`);
  }
  assert.equal(h.fake.helpersOpen, 0, `${label}: a helper container was left behind`);
  assert.deepEqual(readdirSync(h.stateDir).filter((name) => name.startsWith("snap-")), [], `${label}: a temporary snapshot was left behind`);

  if (outcome instanceof Error) {
    assert.deepEqual(readdirSync(h.outputDir), [], `${label}: a partial bundle was left behind`);
    assert.deepEqual(await readJournals(h.stateDir), [], `${label}: the recovery journal was not cleared even though everything was restored`);
  } else {
    const verification = await verifyBundle(outcome.bundlePath, TEST_PASSPHRASE, { deep: true });
    assert.equal(verification.integrity.status, "verified", `${label}: a "successful" export produced a bad bundle`);
    assert.deepEqual(await readJournals(h.stateDir), [], `${label}: the journal was left after success`);
  }
}

async function runAndSettle(h: Harness, options: Partial<ExportOptions>, run: Parameters<Harness["run"]>[1] = {}): Promise<ExportResult | ExportFailedError> {
  try {
    return await h.run(options, run);
  } catch (error) {
    assert.ok(error instanceof ExportFailedError, `unexpected error type: ${(error as Error).stack}`);
    assert.equal(error.restoreFailed, false, `a restore failed: ${JSON.stringify(error.restore.failed)}`);

    return error;
  }
}

describe("targeted faults: the export fails safely and the apps come back", () => {
  test("the daemon refuses to stop the first app", async () => {
    const h = await makeHarness();
    h.fake.faults.push({ op: "stop", target: "id-app-web", error: new Error("cannot stop: device busy") });
    const outcome = await runAndSettle(h, STOP);

    assert.ok(outcome instanceof ExportFailedError);
    assert.match(outcome.message, /device busy/);
    await assertInstallationIntact(h, outcome, "stop(web) fails");
  });

  test("the daemon refuses to stop the SECOND app: the first, already stopped, is started again", async () => {
    const h = await makeHarness();
    h.fake.faults.push({ op: "stop", target: "id-app-db", error: new Error("boom") });
    const outcome = await runAndSettle(h, STOP);

    assert.ok(outcome instanceof ExportFailedError);
    assert.ok(h.fake.calls.includes("stop:id-app-web"), "web was stopped before the failure");
    await assertInstallationIntact(h, outcome, "stop(db) fails");
  });

  test("a helper container cannot be created while an app is stopped", async () => {
    const h = await makeHarness();
    h.fake.faults.push({ op: "volumeArchive", target: "web-uploads", error: new Error("no such image: helper:local") });
    const outcome = await runAndSettle(h, STOP);

    assert.match((outcome as ExportFailedError).message, /no such image/);
    await assertInstallationIntact(h, outcome, "helper creation fails");
  });

  test("the volume stream dies halfway through, while the app is stopped", async () => {
    const h = await makeHarness({ webBigBytes: 400_000 });
    h.fake.volumeFaults.set("web-uploads", { failAfterBytes: 150_000, error: new Error("input/output error") });
    const outcome = await runAndSettle(h, STOP);

    assert.match((outcome as ExportFailedError).message, /input\/output error/);
    await assertInstallationIntact(h, outcome, "stream dies mid-volume");
  });

  test("a hung read is cut off by the disruption deadline instead of holding the app down", async () => {
    const h = await makeHarness({ webBigBytes: 400_000 });
    h.fake.volumeFaults.set("web-uploads", { stallAfterBytes: 100_000 });
    const started = Date.now();
    const outcome = await runAndSettle(h, STOP, { run: { maxDisruptionMs: 300 } });

    assert.ok(Date.now() - started < 8000, "the export must not wait forever on a stalled read");
    assert.ok(outcome instanceof ExportFailedError);
    assert.match(outcome.message, /time|abort/i);
    await assertInstallationIntact(h, outcome, "stalled read");
  });

  test("the operator cancels while an app is stopped and being copied", async () => {
    const h = await makeHarness({ webBigBytes: 400_000 });
    const controller = new AbortController();
    h.fake.onCall = (op, target) => {
      if (op === "volumeArchive" && target === "web-uploads") {
        setTimeout(() => controller.abort(new Error("cancelled by the operator")), 10);
      }
    };
    h.fake.volumeFaults.set("web-uploads", { stallAfterBytes: 50_000 });
    const outcome = await runAndSettle(h, STOP, { run: { signal: controller.signal } });

    assert.match((outcome as ExportFailedError).message, /cancelled by the operator/);
    await assertInstallationIntact(h, outcome, "cancel while stopped");
  });

  test("a paused (frozen) app is unpaused after a failure", async () => {
    const h = await makeHarness();
    h.fake.volumeFaults.set("db-data", { failAfterBytes: 10_000 });
    const outcome = await runAndSettle(h, FREEZE);

    assert.ok(h.fake.calls.includes("pause:id-app-web"));
    assert.ok(h.fake.calls.includes("unpause:id-app-web"));
    await assertInstallationIntact(h, outcome, "freeze then failure");
  });

  test("the output disk filling up stops the export BEFORE it fills, and apps are restored", async () => {
    const h = await makeHarness({ webBigBytes: 400_000 });
    h.fake.onCall = async (op, target) => {
      if (op === "volumeArchive" && target === "web-uploads") {
        await new Promise((resolve) => setTimeout(resolve, 120)); // let the disk watcher notice
      }
    };
    h.fake.volumeFaults.set("web-uploads", { stallAfterBytes: 50_000 });
    const outcome = await runAndSettle(h, STOP, { run: { freeSpace: () => 4 * 1024 * 1024, minFreeBytes: 64 * 1024 * 1024 } });

    assert.match((outcome as ExportFailedError).message, /nearly full/);
    await assertInstallationIntact(h, outcome, "disk nearly full");
  });

  test("an image that cannot be saved fails the export without disturbing anything", async () => {
    const h = await makeHarness();
    h.fake.faults.push({ op: "imageSave", error: new Error("layer is missing") });
    const outcome = await runAndSettle(h, REHEARSAL);

    assert.match((outcome as ExportFailedError).message, /layer is missing/);
    assert.deepEqual(h.fake.calls.filter((call) => /^(stop|pause):/.test(call)), []);
    await assertInstallationIntact(h, outcome, "imageSave fails");
  });

  test("a missing platform database fails before any app is touched", async () => {
    const h = await makeHarness();
    const { rmSync } = await import("node:fs");
    rmSync(h.dbPath);
    const outcome = await runAndSettle(h, PLATFORM);

    assert.ok(outcome instanceof ExportFailedError);
    assert.deepEqual(h.fake.calls.filter((call) => /^(stop|pause):/.test(call)), []);
    await assertInstallationIntact(h, outcome, "database missing");
  });

  test("a too-short passphrase is refused immediately: nothing is stopped, created or journaled", async () => {
    const h = await makeHarness();
    const plan = await h.plan(STOP);
    const callsBefore = h.fake.calls.length;

    await assert.rejects(h.run({}, { plan, passphrase: "short" }), /at least 12 characters/);
    assert.deepEqual(h.fake.calls.slice(callsBefore), [], "no Docker call may be made for an export that cannot succeed");
    assert.deepEqual(readdirSync(h.outputDir), []);
    assert.deepEqual(readdirSync(h.stateDir), [], "not even a journal");
  });
});

describe("a dump that cannot be proven is not accepted as evidence", () => {
  const cases: Array<[string, (h: Harness) => void, RegExp]> = [
    ["the dump command exits non-zero", (h) => h.fake.execScripts.set("app-db", () => ({ stdout: Buffer.from("partial"), exitCode: 1, stderr: "pg_dumpall: error: connection failed" })), /exited with status 1.*connection failed/],
    ["the dump is cut off (no completion marker)", (h) => h.fake.execScripts.set("app-db", () => ({ stdout: Buffer.from("-- PostgreSQL database cluster dump\n".repeat(20)), exitCode: 0 })), /completion marker/],
    ["the dump is empty", (h) => h.fake.execScripts.set("app-db", () => ({ stdout: Buffer.alloc(0), exitCode: 0 })), /only 0 byte/],
    ["the dump stream dies midway", (h) => h.fake.execScripts.set("app-db", () => ({ stdout: Buffer.alloc(100_000, 65), exitCode: 0, failAfterBytes: 10_000 })), /injected exec stream failure/],
    ["the command cannot be run in the container", (h) => h.fake.faults.push({ op: "exec", error: new Error("OCI runtime exec failed: executable not found") }), /executable not found/]
  ];

  for (const [name, arrange, message] of cases) {
    test(`${name}: the export fails, no bundle remains, the database keeps running`, async () => {
      const h = await makeHarness();
      arrange(h);
      const outcome = await runAndSettle(h, REHEARSAL);

      assert.ok(outcome instanceof ExportFailedError);
      assert.match(outcome.message, message);
      assert.deepEqual(h.fake.calls.filter((call) => /^(stop|pause):/.test(call)), []);
      await assertInstallationIntact(h, outcome, name);
    });
  }

  test("a custom hook that states exit-status-only is accepted — and the evidence says exactly that", async () => {
    const h = await makeHarness();
    h.fake.execScripts.set("app-db", () => ({ stdout: Buffer.alloc(500, 66), exitCode: 0 }));
    const { parseHooksFile } = await import("../migration/hooks.js");
    const hooks = parseHooksFile(JSON.stringify({ db: { cmd: ["dump"], exitStatusOnly: true, covers: ["/var/lib/postgresql"] } }));
    const result = await h.run({ ...REHEARSAL, hooks }) as ExportResult;

    assert.match(result.apps.find((a) => a.name === "db")!.volumes[0]!.evidence[0]!.detail!, /operator accepted exit status alone/);
  });
});

describe("restoration failures are loud, journaled, and recoverable", () => {
  test("if an app cannot be restarted the export reports it, keeps the journal, and `recover` later fixes it", async () => {
    const h = await makeHarness();
    h.fake.faults.push({ op: "start", target: "id-app-web", error: new Error("port is already allocated") });
    let failure: ExportFailedError | undefined;
    try {
      await h.run(STOP);
    } catch (error) {
      failure = error as ExportFailedError;
    }

    assert.ok(failure instanceof ExportFailedError);
    assert.equal(failure.restoreFailed, true);
    assert.deepEqual(failure.restore.failed.map((f) => f.containerName), ["app-web"]);
    assert.match(failure.restore.failed[0]!.error, /port is already allocated/);
    assert.equal(h.fake.state("app-web").running, false, "the daemon really refused");
    assert.deepEqual(readdirSync(h.outputDir), [], "the partial bundle is still removed");

    const journals = await readJournals(h.stateDir);
    assert.equal(journals.length, 1, "the journal is kept: it is the only record of what is still down");
    assert.ok(journals[0]!.entries.some((e) => e.containerName === "app-web" && e.state === "restore-failed"));

    // The operator fixes the cause and runs recovery.
    h.fake.faults.length = 0;
    const recovered = await recoverDisruptions(h.fake, h.stateDir, { sleep: noSleep, verifyMs: 50, attempts: 3, force: true });
    assert.deepEqual(recovered[0]!.failed, []);
    assert.equal(h.fake.state("app-web").running, true);
    assert.deepEqual(await readJournals(h.stateDir), []);
  });

  test("a later export first recovers apps an earlier, killed export left stopped", async () => {
    const h = await makeHarness();
    // Simulate a crashed export: the journal says web was stopped, and it IS stopped.
    const { JournalStore } = await import("../migration/export-journal.js");
    const crashed = new JournalStore(h.stateDir, "22222222-2222-4222-8222-222222222222", () => new Date(Date.now() - 3_600_000));
    await crashed.create("/gone");
    await crashed.append({ appRef: "app:1", containerName: "app-web", action: "stop", wasRunning: true });
    await h.fake.stopContainer("id-app-web");

    const result = await h.run(REHEARSAL) as ExportResult;

    assert.ok(h.logs.some((line) => /Recovered from an earlier interrupted export: restarted app-web/.test(line)));
    assert.equal(h.fake.state("app-web").running, true);
    assert.equal((await verifyBundle(result.bundlePath, TEST_PASSPHRASE)).integrity.status, "verified");
  });

  test("two exports cannot run at once: the second is refused and touches nothing", async () => {
    const h = await makeHarness({ webBigBytes: 400_000 });
    const controller = new AbortController();
    h.fake.volumeFaults.set("web-uploads", { stallAfterBytes: 50_000 });
    const first = h.run(STOP, { run: { signal: controller.signal, bundleName: "first" } }).catch((e: Error) => e);

    // Wait until the first export is genuinely stalled mid-volume with web stopped.
    for (let i = 0; i < 300 && !h.fake.calls.includes("volumeArchive:web-uploads"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(h.fake.state("app-web").running, false);
    assert.ok(h.fake.calls.includes("volumeArchive:web-uploads"));

    const callsBefore = h.fake.calls.length;
    await assert.rejects(h.run(REHEARSAL, { run: { bundleName: "second" } }), ExportBusyError);
    assert.deepEqual(h.fake.calls.slice(callsBefore).filter((call) => /^(stop|start|pause|unpause|volumeArchive|exec):/.test(call)), []);

    controller.abort(new Error("test over"));
    assert.ok((await first) instanceof ExportFailedError);
    await assertInstallationIntact(h, new ExportFailedError(new Error("x"), { restored: [], failed: [] }, true, ""), "after the first export was cancelled");
  });
});

const configs: Array<[string, Partial<ExportOptions>]> = [
  ["stopping apps", STOP],
  ["pausing apps", FREEZE],
  ["dump + live copy + images", REHEARSAL],
  ["whole platform", PLATFORM]
];

describe("systematic sweeps: break or cancel the export at EVERY Docker call", () => {
  for (const [name, options] of configs) {
    test(`${name}: a fault injected at every Docker call leaves the installation intact`, async () => {
      const reference = await makeHarness();
      const referencePlan = await reference.plan(options);
      let total = 0;
      reference.fake.onCall = () => {
        total += 1;
      };
      await reference.run({}, { plan: referencePlan });
      assert.ok(total >= 4, `expected a meaningful number of calls, saw ${total}`);

      let failures = 0;
      let successes = 0;
      for (let k = 1; k <= total; k += 1) {
        const h = await makeHarness();
        const plan = await h.plan(options); // planning happens before the export; only the export is faulted
        let count = 0;
        h.fake.onCall = (op, target) => {
          count += 1;
          if (count === k) {
            throw new Error(`injected failure at call #${k} (${op}:${target})`);
          }
        };
        const outcome = await runAndSettle(h, {}, { plan });
        await assertInstallationIntact(h, outcome, `${name}, fault at call #${k}`);
        if (outcome instanceof ExportFailedError) {
          failures += 1;
        } else {
          successes += 1; // the fault hit something the engine retries or can ignore
        }
      }
      assert.ok(failures > 0, "the sweep never actually broke anything");
      assert.equal(failures + successes, total);
    });

    test(`${name}: cancelling at every Docker call leaves the installation intact`, async () => {
      const reference = await makeHarness();
      const referencePlan = await reference.plan(options);
      let total = 0;
      reference.fake.onCall = () => {
        total += 1;
      };
      await reference.run({}, { plan: referencePlan });

      let cancelled = 0;
      for (let k = 1; k <= total; k += 1) {
        const h = await makeHarness();
        const plan = await h.plan(options);
        const controller = new AbortController();
        let count = 0;
        h.fake.onCall = () => {
          count += 1;
          if (count === k) {
            controller.abort(new Error(`cancelled at call #${k}`));
          }
        };
        const outcome = await runAndSettle(h, {}, { plan, run: { signal: controller.signal } });
        await assertInstallationIntact(h, outcome, `${name}, cancel at call #${k}`);
        if (outcome instanceof ExportFailedError) {
          cancelled += 1;
        }
      }
      assert.ok(cancelled > 0, "the sweep never actually cancelled anything");
    });
  }
});

describe("systematic sweeps: break or cancel the export at EVERY one of its own steps", () => {
  for (const [name, options] of configs) {
    test(`${name}: a failure at every step leaves the installation intact`, async () => {
      const reference = await makeHarness();
      const referencePlan = await reference.plan(options);
      const seen: string[] = [];
      await reference.run({}, { plan: referencePlan, run: { onStep: (step) => void seen.push(step) } });
      assert.ok(seen.length >= 4, `expected several steps, saw ${seen.join(",")}`);
      assert.ok(seen.includes("finalize") && seen.includes("verify"));

      for (let k = 1; k <= seen.length; k += 1) {
        const h = await makeHarness();
        const plan = await h.plan(options);
        let count = 0;
        const outcome = await runAndSettle(h, {}, {
          plan,
          run: {
            onStep: (step) => {
              count += 1;
              if (count === k) {
                throw new Error(`injected failure at step #${k} (${step})`);
              }
            }
          }
        });

        assert.ok(outcome instanceof ExportFailedError, `step #${k} (${seen[k - 1]}) must fail the export`);
        assert.match(outcome.message, /injected failure at step/);
        await assertInstallationIntact(h, outcome, `${name}, failure at step #${k} (${seen[k - 1]})`);
      }
    });

    test(`${name}: cancelling at every step leaves the installation intact`, async () => {
      const reference = await makeHarness();
      const referencePlan = await reference.plan(options);
      let total = 0;
      await reference.run({}, { plan: referencePlan, run: { onStep: () => void (total += 1) } });

      let cancelled = 0;
      for (let k = 1; k <= total; k += 1) {
        const h = await makeHarness();
        const plan = await h.plan(options);
        const controller = new AbortController();
        let count = 0;
        const outcome = await runAndSettle(h, {}, {
          plan,
          run: {
            signal: controller.signal,
            onStep: () => {
              count += 1;
              if (count === k) {
                controller.abort(new Error(`cancelled at step #${k}`));
              }
            }
          }
        });
        await assertInstallationIntact(h, outcome, `${name}, cancel at step #${k}`);
        if (outcome instanceof ExportFailedError) {
          cancelled += 1;
        }
      }
      assert.ok(cancelled >= total - 1, "cancelling before the final verification must stop the export");
    });
  }
});
