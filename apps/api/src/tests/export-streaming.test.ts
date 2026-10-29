import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { BundleReader } from "../migration/bundle.js";
import { ExportRefusedError } from "../migration/export.js";
import { bufferEntry, incompressibleEntry, lazyTar, syntheticEntry } from "./export-fakes.js";
import { makeHarness } from "./export-harness.js";
import { MIB } from "./migration-env-fixtures.js";
import { cleanupTempDirs, TEST_PASSPHRASE } from "./migration-fixtures.js";

after(cleanupTempDirs);

/** Total size of every file under `dir`. */
function treeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? treeBytes(path) : statSync(path).size;
  }

  return total;
}

/** Samples process memory and on-disk size while `work` runs. */
async function observe<T>(work: () => Promise<T>, dirs: string[]): Promise<{ result: T; peakRssGrowth: number; peakDiskBytes: number }> {
  global.gc?.();
  const baseline = process.memoryUsage.rss();
  let peakRss = baseline;
  let peakDisk = 0;
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    peakDisk = Math.max(peakDisk, dirs.reduce((sum, dir) => sum + treeBytes(dir), 0));
  }, 15);

  try {
    return { result: await work(), peakRssGrowth: peakRss - baseline, peakDiskBytes: peakDisk };
  } finally {
    clearInterval(timer);
  }
}

describe("streaming: nothing is buffered, nothing is copied twice", () => {
  test("a 320 MiB volume is exported with bounded memory and no staging copy on disk", async () => {
    const SIZE = 320 * MIB;
    const h = await makeHarness();
    h.fake.addVolume("web-uploads", [bufferEntry("./index.html", Buffer.from("x")), syntheticEntry("./huge.bin", SIZE, 3)]);
    // (verify: "structure" here — the full-bundle read-back is exercised separately below.)
    const base = join(h.outputDir, "..");

    const { result, peakRssGrowth, peakDiskBytes } = await observe(
      () => h.run({ scope: "application", operation: "backup", appId: 1, selection: [], mode: "rehearsal" }, { run: { verify: "structure" } }),
      [base]
    );

    const volume = result.apps[0]!.volumes[0]!;
    assert.ok(volume.uncompressedBytes > SIZE, "the whole volume was read");
    assert.ok(peakRssGrowth < 220 * MIB, `memory grew by ${(peakRssGrowth / MIB).toFixed(0)} MiB for a ${SIZE / MIB} MiB volume: it is being buffered`);

    // The synthetic data compresses extremely well; an UNCOMPRESSED staging copy would be ~320 MiB.
    assert.ok(peakDiskBytes < 40 * MIB, `${(peakDiskBytes / MIB).toFixed(0)} MiB was on disk at peak: a full-size intermediate copy exists`);
    assert.ok(result.artifacts.find((a) => a.kind === "volume")!.ciphertextBytes < 40 * MIB);
  });

  test("incompressible data: the bundle grows to the data's size and no more (no second copy), still bounded in memory", async () => {
    const SIZE = 96 * MIB;
    const h = await makeHarness();
    h.fake.addVolume("web-uploads", [incompressibleEntry("./random.bin", SIZE, 11)]);
    const base = join(h.outputDir, "..");

    const { result, peakRssGrowth, peakDiskBytes } = await observe(
      () => h.run({ scope: "application", operation: "backup", appId: 1, selection: [], mode: "rehearsal" }, { run: { verify: "structure" } }),
      [base]
    );
    const bundleBytes = treeBytes(result.bundlePath);

    assert.ok(bundleBytes > SIZE * 0.95 && bundleBytes < SIZE * 1.1, `bundle is ${bundleBytes} bytes for ${SIZE} bytes of random data`);
    assert.ok(peakDiskBytes < bundleBytes * 1.2 + 4 * MIB, `peak disk ${(peakDiskBytes / MIB).toFixed(0)} MiB vs final ${(bundleBytes / MIB).toFixed(0)} MiB: a staging copy was written`);
    assert.ok(peakRssGrowth < 160 * MIB, `memory grew by ${(peakRssGrowth / MIB).toFixed(0)} MiB`);
  });

  test("the streamed bytes are exactly the volume's bytes: decrypt → gunzip → hash equals the source", async () => {
    const entries = [bufferEntry("./a.txt", Buffer.from("hello")), incompressibleEntry("./random.bin", 24 * MIB, 5), syntheticEntry("./pattern.bin", 9 * MIB, 2)];
    const h = await makeHarness();
    h.fake.addVolume("web-uploads", entries);
    const result = await h.run({ scope: "application", operation: "backup", appId: 1, selection: [], mode: "rehearsal" }, { run: { verify: "none" } });

    const expected = createHash("sha256");
    for await (const chunk of lazyTar(entries)) {
      expected.update(chunk as Buffer);
    }

    const reader = await BundleReader.open(result.bundlePath, TEST_PASSPHRASE);
    const artifact = reader.manifest.artifacts.find((a) => a.kind === "volume")!;
    const actual = createHash("sha256");
    // Decrypted, gunzipped and hashed as a STREAM: the test itself buffers nothing either.
    const sink = new Writable({ write: (chunk: Buffer, _e, cb) => (actual.update(chunk), cb()) });
    const gunzip = createGunzip();
    gunzip.pipe(sink);
    await reader.readArtifact(artifact.id, gunzip);
    await new Promise((resolve) => sink.on("finish", resolve));

    assert.equal(actual.digest("hex"), expected.digest("hex"));
    assert.equal(artifact.meta.uncompressedBytes, lazyTarSize(entries));
    void pipeline;
  });

  test("a deep verification of a large bundle also streams (no buffering on the read side)", async () => {
    const h = await makeHarness();
    h.fake.addVolume("web-uploads", [incompressibleEntry("./random.bin", 64 * MIB, 8)]);
    const result = await h.run({ scope: "application", operation: "backup", appId: 1, selection: [], mode: "rehearsal" }, { run: { verify: "none" } });
    const { verifyBundle } = await import("../migration/bundle.js");

    const { result: verification, peakRssGrowth } = await observe(() => verifyBundle(result.bundlePath, TEST_PASSPHRASE, { deep: true }), [h.outputDir]);
    assert.equal(verification.integrity.status, "verified");
    assert.ok(peakRssGrowth < 120 * MIB, `verification grew memory by ${(peakRssGrowth / MIB).toFixed(0)} MiB`);
  });
});

describe("disk-space preflight happens before anything is touched", () => {
  test("a plan that cannot fit is refused; no container is stopped and no bundle directory appears", async () => {
    const h = await makeHarness();
    const plan = await h.plan({ scope: "application", operation: "move", appId: 1, selection: [2, 3], mode: "cutover", strategies: { default: "stop", perApp: {} }, acceptRisks: { web: "quiesced-unverified", db: "quiesced-unverified" } }, { freeBytes: 1 * MIB });

    assert.ok(plan.refusals.some((r) => r.code === "insufficient-disk"));
    await assert.rejects(h.run({}, { plan }), ExportRefusedError);
    assert.deepEqual(h.fake.calls.filter((c) => /^(stop|start|pause|unpause|volumeArchive|exec|imageSave):/.test(c)), []);
    assert.deepEqual(readdirSync(h.outputDir), []);
  });
});

/** Size of the tar `lazyTar` would produce. */
function lazyTarSize(entries: Array<{ size: number }>): number {
  return entries.reduce((sum, entry) => sum + 512 + Math.ceil(entry.size / 512) * 512, 0) + 1024;
}
