import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { readJournals, recoverDisruptions } from "../migration/export-journal.js";
import { FakeExportDocker } from "./export-fakes.js";
import { noSleep } from "./export-harness.js";
import { cleanupTempDirs, makeTempDir } from "./migration-fixtures.js";

after(cleanupTempDirs);

const child = fileURLToPath(new URL("./export-kill-child.ts", import.meta.url));

/** Kills the process and waits until it is really gone. Fails if it had already exited by itself. */
async function killAndWait(proc: ChildProcess): Promise<void> {
  assert.equal(proc.exitCode, null, `the exporter had already exited on its own (code ${proc.exitCode}); there was nothing to kill`);
  assert.equal(proc.signalCode, null);
  const gone = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  assert.equal(proc.kill("SIGKILL"), true, "SIGKILL was not delivered");
  await Promise.race([gone, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("the killed exporter never exited")), 15_000))]);
  assert.ok(proc.exitCode !== 0, "a killed process does not exit cleanly");
}

/** Spawns the exporter, waits until it is mid-snapshot with an app stopped, and returns the live process. */
async function startExporter(baseDir: string, statePath: string): Promise<{ process: ChildProcess; output: () => string }> {
  const proc = spawn(process.execPath, ["--import", "tsx", child, baseDir, statePath], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  proc.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the exporter never reached the snapshot. Output:\n${output}`)), 90_000);
    const poll = setInterval(() => {
      if (output.includes("STOPPED-AND-STREAMING")) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 25);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      if (!output.includes("STOPPED-AND-STREAMING")) {
        reject(new Error(`the exporter exited (${code}) before the snapshot. Output:\n${output}`));
      }
    });
  });

  return { process: proc, output: () => output };
}

describe("a hard-killed exporter (SIGKILL: no cleanup code runs) is recoverable from disk alone", () => {
  test("the app is left stopped, the journal says so, and recovery restarts it and clears the wreckage", async () => {
    const base = makeTempDir("cfmig-kill-");
    const statePath = join(base, "fake-docker-state.json");
    const exporter = await startExporter(base, statePath);

    try {
      // --- the moment before the crash: an app is stopped, mid-snapshot ------------
      const before = new FakeExportDocker(statePath);
      assert.equal(before.state("app-web").running, false, "web must really be stopped while its volume is read");
      assert.equal(before.state("app-static").running, true, "unrelated apps are untouched");

      await killAndWait(exporter.process);
    } finally {
      if (exporter.process.exitCode === null && exporter.process.signalCode === null) {
        exporter.process.kill("SIGKILL");
      }
    }

    // --- the wreckage, as a different process finds it ----------------------------------
    const daemon = new FakeExportDocker(statePath);
    assert.equal(daemon.state("app-web").running, false, "the killed exporter left web STOPPED — nothing cleaned up");

    const stateDir = join(base, "state");
    const journals = await readJournals(stateDir);
    assert.equal(journals.length, 1, "the journal survived the kill");
    const entry = journals[0]!.entries.find((e) => e.containerName === "app-web")!;
    assert.ok(entry && entry.wasRunning && entry.state !== "restored", "and it names the app that was stopped");

    const partialBundle = journals[0]!.bundlePath;
    assert.ok(existsSync(partialBundle), "an incomplete bundle was left behind");
    assert.ok(!existsSync(join(partialBundle, "manifest.enc")), "...which is provably unfinished (no manifest)");

    // --- recovery ---------------------------------------------------------------------------
    // The dead exporter's heartbeat goes stale; treat it as such (a real run waits ~60 s, or uses --force).
    const results = await recoverDisruptions(daemon, stateDir, { sleep: noSleep, verifyMs: 50, attempts: 3, force: true });

    assert.equal(results.length, 1);
    assert.deepEqual(results[0]!.failed, []);
    assert.ok(results[0]!.restored.includes("app-web"));
    assert.equal(results[0]!.partialBundleRemoved, true);

    const after = new FakeExportDocker(statePath);
    for (const name of ["app-web", "app-db", "app-worker", "app-static"]) {
      assert.deepEqual([after.state(name).running, after.state(name).paused], [true, false], `${name} must be running after recovery`);
    }
    assert.deepEqual(await readJournals(stateDir), [], "the journal is cleared");
    assert.ok(!existsSync(partialBundle), "the unfinished bundle is removed");
    assert.deepEqual(readdirSync(join(base, "out")), []);
  });

  test("a journal with a LIVE heartbeat is not recovered out from under a running export", async () => {
    const base = makeTempDir("cfmig-kill-");
    const statePath = join(base, "fake-docker-state.json");
    const exporter = await startExporter(base, statePath);

    try {
      const daemon = new FakeExportDocker(statePath);
      assert.equal(daemon.state("app-web").running, false);

      // Without --force, a fresh heartbeat means "this export is alive": recovery must leave it alone.
      const results = await recoverDisruptions(daemon, join(base, "state"), { sleep: noSleep, verifyMs: 50, attempts: 2 });
      assert.equal(results[0]!.skippedActive, true);
      assert.equal(new FakeExportDocker(statePath).state("app-web").running, false, "the live export still owns web");
      await killAndWait(exporter.process);
    } finally {
      if (exporter.process.exitCode === null && exporter.process.signalCode === null) {
        exporter.process.kill("SIGKILL");
      }
    }

    // Once it is dead its heartbeat ages out and recovery proceeds without --force.
    const later = () => new Date(Date.now() + 5 * 60_000);
    const daemon = new FakeExportDocker(statePath);
    const results = await recoverDisruptions(daemon, join(base, "state"), { sleep: noSleep, verifyMs: 50, attempts: 3, now: later });
    assert.equal(results[0]!.skippedActive, false);
    assert.equal(new FakeExportDocker(statePath).state("app-web").running, true);
  });
});
