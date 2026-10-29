import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { JournalStore, readJournals, recoverDisruptions, restoreContainer } from "../migration/export-journal.js";
import { ContainerMissingError, DisruptionGuard } from "../migration/quiesce.js";
import {
  ByteCounter,
  DockerFrameDemux,
  LimitedCollector,
  TailCapture,
  compressed,
  demuxBuffer
} from "../migration/streams.js";
import { FakeExportDocker } from "./export-fakes.js";
import { cleanupTempDirs, makeTempDir } from "./migration-fixtures.js";

after(cleanupTempDirs);

const noSleep = async (): Promise<void> => undefined;
const FAST = { sleep: noSleep, verifyMs: 50, attempts: 3 };

function frame(type: 1 | 2, payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);

  return Buffer.concat([header, body]);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

describe("stream primitives", () => {
  test("the demuxer splits stdout from stderr, even when frames are cut at arbitrary points", async () => {
    const wire = Buffer.concat([frame(1, "hello "), frame(2, "warn"), frame(1, "world"), frame(1, Buffer.alloc(0))]);
    const stdout = new PassThrough();
    const stderr: Buffer[] = [];
    const demux = new DockerFrameDemux(stdout, (chunk) => stderr.push(chunk));
    const out = collect(stdout);

    for (let offset = 0; offset < wire.length; offset += 3) {
      demux.write(wire.subarray(offset, offset + 3));
    }
    demux.end();

    assert.equal((await out).toString(), "hello world");
    assert.equal(Buffer.concat(stderr).toString(), "warn");
  });

  test("the demuxer rejects a truncated stream and an implausible frame", async () => {
    const truncated = new DockerFrameDemux(new PassThrough(), () => undefined);
    truncated.write(frame(1, "complete").subarray(0, 12));
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        truncated.on("error", reject);
        truncated.on("finish", resolve);
        truncated.end();
      }),
      /truncated/
    );

    const bogus = Buffer.alloc(8);
    bogus[0] = 1;
    bogus.writeUInt32BE(0x7fffffff, 4);
    const huge = new DockerFrameDemux(new PassThrough(), () => undefined);
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        huge.on("error", reject);
        huge.write(bogus, (error) => (error ? reject(error) : resolve()));
      }),
      /implausibly large/
    );
  });

  test("the demuxer applies BACKPRESSURE: a slow consumer does not make data pile up in memory", async () => {
    const frames = 400;
    const payload = Buffer.alloc(16 * 1024, 7); // 6.4 MB in total
    const wire = Buffer.concat(Array.from({ length: frames }, () => frame(1, payload)));
    const stdout = new PassThrough({ highWaterMark: 64 * 1024 });
    const demux = new DockerFrameDemux(stdout, () => undefined);

    let peakBuffered = 0;
    let received = 0;
    const slowSink = new Writable({
      highWaterMark: 16 * 1024,
      write(chunk: Buffer, _encoding, callback) {
        peakBuffered = Math.max(peakBuffered, stdout.readableLength);
        received += chunk.length;
        setImmediate(callback); // a consumer that is slower than the producer
      }
    });

    const raw = Readable.from(
      (function* () {
        for (let offset = 0; offset < wire.length; offset += 4096) {
          yield wire.subarray(offset, offset + 4096);
        }
      })()
    );
    await Promise.all([pipeline(raw, demux), pipeline(stdout, slowSink)]);

    assert.equal(received, frames * payload.length);
    assert.ok(peakBuffered <= 256 * 1024, `buffered ${peakBuffered} bytes: backpressure is not working`);
  });

  test("demuxBuffer parses a small multiplexed log", () => {
    const parsed = demuxBuffer(Buffer.concat([frame(1, "a"), frame(2, "b"), frame(1, "c")]));

    assert.deepEqual(parsed, { stdout: "ac", stderr: "b" });
  });

  test("TailCapture keeps only the tail; LimitedCollector keeps only the head", async () => {
    const tail = new TailCapture(10);
    await pipeline(Readable.from([Buffer.from("0123456789"), Buffer.from("ABCDEFGHIJ"), Buffer.from("klm")]), tail, new Writable({ write: (_c, _e, cb) => cb() }));
    assert.equal(tail.tailText(), "DEFGHIJklm");
    assert.equal(tail.bytes, 23);

    const limited = new LimitedCollector(5);
    limited.write(Buffer.from("abc"));
    limited.write(Buffer.from("defgh"));
    assert.equal(limited.text(), "abcde");
    assert.equal(limited.dropped, 3);
  });

  test("compression round-trips and counts the uncompressed bytes", async () => {
    const data = Buffer.alloc(300_000, "abc");
    const counter = new ByteCounter();
    const out = await collect(compressed(Readable.from([data]), { level: 3, counter }));

    assert.ok(gunzipSync(out).equals(data));
    assert.equal(counter.bytes, data.length);
    assert.ok(out.length < data.length / 10);
  });

  test("a failure in the source reaches the consumer; a truncated archive is never produced silently", async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.alloc(1000, 1));
        this.destroy(new Error("disk went away"));
      }
    });

    await assert.rejects(collect(compressed(failing, { level: 3 })), /disk went away/);
  });

  test("an abort signal stops the stream with an error", async () => {
    const controller = new AbortController();
    const endless = new Readable({
      read() {
        this.push(Buffer.alloc(1024));
      }
    });
    const result = collect(compressed(endless, { level: 1, signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(result, /abort/i);
  });
});

describe("recovery journal: written BEFORE the container is touched", () => {
  test("the stop is preceded by a durable journal entry", async () => {
    const dir = makeTempDir("cfmig-journal-");
    const fake = new FakeExportDocker().addContainer({ name: "app-db" });
    const journal = new JournalStore(dir);
    await journal.create(join(dir, "bundle"));
    let sawIntentOnDisk = false;
    fake.onCall = (op) => {
      if (op === "stop") {
        const onDisk = JSON.parse(readFileSync(journal.path, "utf8"));
        sawIntentOnDisk = onDisk.entries.some((e: { containerName: string; state: string }) => e.containerName === "app-db" && e.state === "intent");
      }
    };

    await new DisruptionGuard(fake, journal, FAST).stop({ ref: "app:2", containerName: "app-db" });

    assert.equal(sawIntentOnDisk, true, "the journal must be on disk before the container is stopped");
  });

  test("the journal is written atomically and leaves no temp file behind", async () => {
    const dir = makeTempDir("cfmig-journal-");
    const journal = new JournalStore(dir);
    await journal.create("/x");
    await journal.append({ appRef: "app:1", containerName: "c", action: "stop", wasRunning: true });

    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
    assert.equal((await readJournals(dir))[0]?.entries.length, 1);
  });

  test("foreign and half-written files in the state directory never break recovery", async () => {
    const dir = makeTempDir("cfmig-journal-");
    writeFileSync(join(dir, "export-bad.journal.json"), "{ not json");
    writeFileSync(join(dir, "notes.txt"), "hello");

    assert.deepEqual(await readJournals(dir), []);
    assert.deepEqual(await recoverDisruptions(new FakeExportDocker(), dir, FAST), []);
  });
});

describe("disruption guard", () => {
  async function setup(spec: Partial<Parameters<FakeExportDocker["addContainer"]>[0]> = {}) {
    const dir = makeTempDir("cfmig-guard-");
    const fake = new FakeExportDocker().addContainer({ name: "app-db", ...spec });
    const journal = new JournalStore(dir);
    await journal.create(join(dir, "bundle"));

    return { fake, journal, guard: new DisruptionGuard(fake, journal, FAST), dir };
  }

  test("stop records process-level evidence and restore brings the app back", async () => {
    const { fake, guard } = await setup();
    const outcome = await guard.stop({ ref: "app:2", containerName: "app-db" });

    assert.deepEqual(outcome, { wasRunning: true, exitCode: 0, oomKilled: false, cleanExit: true, forcedKill: false });
    assert.equal(fake.state("app-db").running, false);
    assert.equal(guard.outstanding().length, 1);

    await guard.restore("app:2");
    assert.equal(fake.state("app-db").running, true);
    assert.equal(guard.outstanding().length, 0);
  });

  test("a killed or out-of-memory stop is reported as a forced kill, never as a clean exit", async () => {
    const killed = await setup({ exitCodeOnStop: 137 });
    assert.deepEqual(
      await killed.guard.stop({ ref: "app:2", containerName: "app-db" }),
      { wasRunning: true, exitCode: 137, oomKilled: false, cleanExit: false, forcedKill: true }
    );

    const oom = await setup({ exitCodeOnStop: 0, oomKilled: true });
    const outcome = await oom.guard.stop({ ref: "app:2", containerName: "app-db" });
    assert.equal(outcome.cleanExit, false);
    assert.equal(outcome.forcedKill, true);

    const odd = await setup({ exitCodeOnStop: 143 });
    const sigterm = await odd.guard.stop({ ref: "app:2", containerName: "app-db" });
    assert.equal(sigterm.cleanExit, false); // exit 143 is not evidence of an orderly shutdown
    assert.equal(sigterm.forcedKill, false);
  });

  test("an app that is already stopped is not disturbed and is not journaled", async () => {
    const { fake, guard, journal } = await setup({ running: false });
    const outcome = await guard.stop({ ref: "app:2", containerName: "app-db" });

    assert.equal(outcome.wasRunning, false);
    assert.equal(journal.entries().length, 0);
    assert.ok(!fake.calls.some((call) => call.startsWith("stop:")));
  });

  test("a missing container and an externally paused one are refused", async () => {
    const { guard, fake } = await setup();
    await assert.rejects(guard.stop({ ref: "app:9", containerName: "nope" }), ContainerMissingError);

    await fake.pauseContainer("id-app-db");
    await assert.rejects(guard.stop({ ref: "app:2", containerName: "app-db" }), /paused by something else/);
  });

  test("freeze pauses and restore unpauses", async () => {
    const { fake, guard } = await setup();

    assert.deepEqual(await guard.freeze({ ref: "app:2", containerName: "app-db" }), { wasRunning: true });
    assert.equal(fake.state("app-db").paused, true);

    await guard.restoreAll();
    assert.deepEqual(fake.state("app-db"), { running: true, paused: false, exitCode: null });
  });

  test("restoreAll never throws, restores newest first, and reports every failure", async () => {
    const dir = makeTempDir("cfmig-guard-");
    const fake = new FakeExportDocker().addContainer({ name: "app-web" }).addContainer({ name: "app-db" }).addContainer({ name: "app-cache" });
    const journal = new JournalStore(dir);
    await journal.create("/x");
    const guard = new DisruptionGuard(fake, journal, FAST);
    for (const [ref, name] of [["app:1", "app-web"], ["app:2", "app-db"], ["app:3", "app-cache"]] as const) {
      await guard.stop({ ref, containerName: name });
    }
    fake.faults.push({ op: "start", target: "id-app-db", error: new Error("daemon refused") });
    const startOrder: string[] = [];
    fake.onCall = (op, target) => {
      if (op === "start") {
        startOrder.push(target);
      }
    };

    const summary = await guard.restoreAll();

    assert.deepEqual(summary.restored.sort(), ["app-cache", "app-web"]);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0]?.containerName, "app-db");
    assert.match(summary.failed[0]!.error, /daemon refused/);
    assert.equal(startOrder[0], "id-app-cache"); // most recently stopped comes back first
    assert.equal(fake.state("app-web").running, true);
    assert.equal(fake.state("app-db").running, false);
    assert.equal(journal.unrestored().length, 1); // the failure stays on record
  });

  test("a transient failure to start is retried until it works", async () => {
    const { fake, guard } = await setup();
    await guard.stop({ ref: "app:2", containerName: "app-db" });
    fake.faults.push({ op: "start", times: 2 });

    assert.deepEqual((await guard.restoreAll()).failed, []);
    assert.equal(fake.state("app-db").running, true);
    assert.equal(fake.calls.filter((call) => call.startsWith("start:")).length, 3);
  });

  test("restoring VERIFIES the container is running; a start that does nothing is a failure", async () => {
    const { fake, guard } = await setup();
    await guard.stop({ ref: "app:2", containerName: "app-db" });
    fake.startContainer = async () => undefined; // the daemon "accepts" the start but nothing happens

    const summary = await guard.restoreAll();
    assert.equal(summary.failed.length, 1);
    assert.match(summary.failed[0]!.error, /did not report running/);
  });
});

describe("crash recovery from the journal", () => {
  async function crashed(options: { stopped: boolean }) {
    const dir = makeTempDir("cfmig-recover-");
    const fake = new FakeExportDocker().addContainer({ name: "app-db" }).addContainer({ name: "app-web" });
    const journal = new JournalStore(dir, "11111111-1111-4111-8111-111111111111");
    await journal.create(join(dir, "bundle"));
    await journal.append({ appRef: "app:2", containerName: "app-db", action: "stop", wasRunning: true });
    await journal.append({ appRef: "app:1", containerName: "app-web", action: "pause", wasRunning: true });
    if (options.stopped) {
      await fake.stopContainer("id-app-db");
      await fake.pauseContainer("id-app-web");
    }
    // ...and then the exporting process "dies": nothing restores anything.

    return { dir, fake, journal };
  }

  test("recovery puts a stopped and a paused app back, then removes the journal", async () => {
    const { dir, fake } = await crashed({ stopped: true });
    const results = await recoverDisruptions(fake, dir, { ...FAST, force: true });

    assert.equal(results.length, 1);
    assert.deepEqual(results[0]!.restored.sort(), ["app-db", "app-web"]);
    assert.deepEqual(fake.state("app-db"), { running: true, paused: false, exitCode: 0 });
    assert.equal(fake.state("app-web").paused, false);
    assert.deepEqual(await readJournals(dir), []);
  });

  test("an intent whose disruption never happened is harmless: nothing is changed, the journal is cleared", async () => {
    const { dir, fake } = await crashed({ stopped: false });
    const before = fake.calls.length;
    const results = await recoverDisruptions(fake, dir, { ...FAST, force: true });

    assert.deepEqual(results[0]!.failed, []);
    assert.ok(!fake.calls.slice(before).some((call) => /^(start|unpause|stop|pause):/.test(call)));
    assert.deepEqual(await readJournals(dir), []);
  });

  test("a journal with a fresh heartbeat belongs to a LIVE export and is left alone unless forced", async () => {
    const { dir, fake, journal } = await crashed({ stopped: true });
    await journal.heartbeat();

    const live = await recoverDisruptions(fake, dir, FAST);
    assert.equal(live[0]!.skippedActive, true);
    assert.equal(fake.state("app-db").running, false);

    const forced = await recoverDisruptions(fake, dir, { ...FAST, force: true });
    assert.equal(forced[0]!.skippedActive, false);
    assert.equal(fake.state("app-db").running, true);
  });

  test("a stale heartbeat is treated as a dead export", async () => {
    const { dir, fake } = await crashed({ stopped: true });
    const later = () => new Date(Date.now() + 10 * 60_000);

    const results = await recoverDisruptions(fake, dir, { ...FAST, now: later });
    assert.equal(results[0]!.skippedActive, false);
    assert.equal(fake.state("app-db").running, true);
  });

  test("recovery that cannot restore something keeps the journal and says so, and a retry succeeds", async () => {
    const { dir, fake } = await crashed({ stopped: true });
    fake.faults.push({ op: "start", target: "id-app-db", error: new Error("still failing") });

    const first = await recoverDisruptions(fake, dir, { ...FAST, force: true });
    assert.equal(first[0]!.failed.length, 1);
    assert.equal(fake.state("app-web").paused, false); // the other app was still restored
    assert.equal((await readJournals(dir)).length, 1);
    assert.equal((await readJournals(dir))[0]!.entries.filter((e) => e.state === "restored").length, 1);

    fake.faults.length = 0;
    const second = await recoverDisruptions(fake, dir, { ...FAST, force: true });
    assert.deepEqual(second[0]!.failed, []);
    assert.equal(fake.state("app-db").running, true);
    assert.deepEqual(await readJournals(dir), []);
  });

  test("recovery is idempotent, and sweeps leftover helper containers", async () => {
    const { dir, fake } = await crashed({ stopped: true });
    await fake.volumeArchive("anything-that-does-not-exist").catch(() => undefined);
    fake.addVolume("v", []);
    await fake.volumeArchive("v"); // a helper container left behind by the crashed export
    assert.equal(fake.helpersOpen, 1);

    const first = await recoverDisruptions(fake, dir, { ...FAST, force: true });
    assert.equal(first[0]!.helpersRemoved, 1);
    assert.equal(fake.helpersOpen, 0);
    assert.deepEqual(await recoverDisruptions(fake, dir, { ...FAST, force: true }), []);
  });

  test("restoreContainer leaves an app that was never running exactly as it was", async () => {
    const fake = new FakeExportDocker().addContainer({ name: "off", running: false });

    assert.equal(await restoreContainer(fake, { containerName: "off", wasRunning: false, action: "stop" }, FAST), "untouched");
    assert.equal(fake.state("off").running, false);
    assert.ok(!existsSync(join(makeTempDir(), "nothing")));
  });
});
