import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, truncateSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Readable } from "node:stream";
import { canonicalJson } from "../migration/canonical-json.js";
import {
  BundleReader,
  BundleWriter,
  verifyBundle,
  type VerifyOptions
} from "../migration/bundle.js";
import { MIN_CHUNK_SIZE } from "../migration/constants.js";
import { WrongPassphraseError } from "../migration/crypto.js";
import {
  checkManifestCompatibility,
  parseManifest,
  serializeManifest
} from "../migration/manifest.js";
import { generateSigningKeyPair, fingerprintOf, signManifest } from "../migration/signing.js";
import {
  APP_NAME,
  buildSyntheticBundle,
  cleanupTempDirs,
  makeTempDir,
  SECRET_MARKER,
  sourceBody,
  TEST_KDF,
  TEST_PASSPHRASE,
  VOLUME_NAME
} from "./migration-fixtures.js";

after(cleanupTempDirs);

const verify = (dir: string, options: VerifyOptions = {}, passphrase = TEST_PASSPHRASE) =>
  verifyBundle(dir, passphrase, options);

function flipByte(path: string, offset: number): void {
  const data = readFileSync(path);
  data[offset] ^= 0x01;
  writeFileSync(path, data);
}

describe("bundle: write, open, read", () => {
  test("round-trips artifacts and exposes the manifest", async () => {
    const bundle = await buildSyntheticBundle();
    const reader = await BundleReader.open(bundle.directory, TEST_PASSPHRASE);

    assert.equal(reader.manifest.bundleId, bundle.bundleId);
    assert.equal(reader.manifest.apps[0]?.name, APP_NAME);
    assert.equal(reader.manifestSha256, bundle.manifestSha256);

    const db = reader.manifest.artifacts.find((a) => a.kind === "platform-database")!;
    const volume = reader.manifest.artifacts.find((a) => a.kind === "volume")!;
    assert.ok((await reader.readArtifactBuffer(db.id)).equals(bundle.databaseData));
    assert.ok((await reader.readArtifactBuffer(volume.id)).equals(bundle.volumeData));
  });

  test("the whole bundle is encrypted: no plaintext, app name or volume name is recoverable", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const needles = [SECRET_MARKER, APP_NAME, VOLUME_NAME, "SQLite format 3", "synthetic-source-1"];
    const files = [
      "bundle.header.json",
      "manifest.enc",
      "manifest.sig.json",
      ...readdirSync(join(bundle.directory, "artifacts")).map((name) => join("artifacts", name))
    ];

    for (const file of files) {
      const content = readFileSync(join(bundle.directory, file)).toString("latin1");
      for (const needle of needles) {
        assert.ok(!content.includes(needle), `${file} leaks "${needle}"`);
      }
    }

    // File names are opaque too.
    for (const name of readdirSync(join(bundle.directory, "artifacts"))) {
      assert.match(name, /^a\d{4}\.enc$/);
    }
  });

  test("a wrong passphrase cannot open it", async () => {
    const bundle = await buildSyntheticBundle();

    await assert.rejects(
      BundleReader.open(bundle.directory, "a completely different passphrase"),
      WrongPassphraseError
    );
  });

  test("the writer refuses a non-empty directory, bad ids and duplicates", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "existing.txt"), "x");
    await assert.rejects(
      BundleWriter.create(dir, { passphrase: TEST_PASSPHRASE, kdf: TEST_KDF }),
      /non-empty directory/
    );

    const writer = await BundleWriter.create(join(makeTempDir(), "b"), {
      passphrase: TEST_PASSPHRASE,
      kdf: TEST_KDF,
      chunkSize: MIN_CHUNK_SIZE
    });
    const spec = { kind: "volume" as const, subject: "platform" as const };

    for (const bad of ["../escape", "a/b", "A0001", "manifest", "", "a".repeat(80), ".hidden"]) {
      await assert.rejects(writer.addArtifact({ id: bad, ...spec }, Buffer.from("x")), /Invalid artifact id/);
    }

    await writer.addArtifact({ id: "a0001", ...spec }, Buffer.from("x"));
    await assert.rejects(writer.addArtifact({ id: "a0001", ...spec }, Buffer.from("y")), /Duplicate/);
  });

  test("a failed artifact write leaves no partial file behind", async () => {
    const writer = await BundleWriter.create(join(makeTempDir(), "b"), {
      passphrase: TEST_PASSPHRASE,
      kdf: TEST_KDF,
      chunkSize: MIN_CHUNK_SIZE
    });
    const failing = new Readable({
      read() {
        this.destroy(new Error("source went away"));
      }
    });

    await assert.rejects(
      writer.addArtifact({ id: "a0001", kind: "volume", subject: "platform" }, failing),
      /source went away/
    );
    assert.deepEqual(readdirSync(join(writer.directory, "artifacts")), []);
  });
});

describe("bundle verification: integrity", () => {
  test("a good bundle verifies at structure and deep depth", async () => {
    const bundle = await buildSyntheticBundle();

    const shallow = await verify(bundle.directory);
    assert.equal(shallow.integrity.status, "verified");
    assert.equal(shallow.integrity.depth, "structure");
    assert.equal(shallow.integrity.artifactsChecked, 3);

    const deep = await verify(bundle.directory, { deep: true });
    assert.equal(deep.integrity.status, "verified");
    assert.equal(deep.integrity.depth, "deep");
    assert.equal(deep.integrity.artifactsChecked, 3);
    assert.deepEqual(deep.integrity.problems, []);
  });

  test("a same-size bit flip passes the structural check but is caught by deep verification", async () => {
    const bundle = await buildSyntheticBundle();
    const volume = bundle.manifest.artifacts.find((a) => a.kind === "volume")!;
    flipByte(join(bundle.directory, "artifacts", `${volume.id}.enc`), 100);

    assert.equal((await verify(bundle.directory)).integrity.status, "verified"); // structure is blind to this
    const deep = await verify(bundle.directory, { deep: true });
    assert.equal(deep.integrity.status, "failed");
    assert.equal(deep.integrity.problems[0]?.code, "ARTIFACT_AUTHENTICATION_FAILED");
    assert.equal(deep.integrity.problems[0]?.artifactId, volume.id);
  });

  test("missing, truncated, unlisted and partial artifact files are reported", async () => {
    const bundle = await buildSyntheticBundle();
    const [db, config, volume] = [
      bundle.manifest.artifacts.find((a) => a.kind === "platform-database")!,
      bundle.manifest.artifacts.find((a) => a.kind === "platform-config")!,
      bundle.manifest.artifacts.find((a) => a.kind === "volume")!
    ];

    rmSync(join(bundle.directory, "artifacts", `${db.id}.enc`));
    truncateSync(join(bundle.directory, "artifacts", `${volume.id}.enc`), 50);
    writeFileSync(join(bundle.directory, "artifacts", "zzz.enc"), "extra");
    writeFileSync(join(bundle.directory, "artifacts", `${config.id}.enc.partial`), "half");

    const codes = (await verify(bundle.directory)).integrity.problems.map((p) => p.code).sort();
    assert.deepEqual(codes, [
      "ARTIFACT_MISSING",
      "ARTIFACT_PARTIAL",
      "ARTIFACT_SIZE_MISMATCH",
      "ARTIFACT_UNLISTED"
    ]);
    assert.equal((await verify(bundle.directory)).integrity.status, "failed");
  });

  test("an artifact swapped in from another bundle (same passphrase and id) is rejected", async () => {
    const a = await buildSyntheticBundle();
    const b = await buildSyntheticBundle();
    const volumeA = a.manifest.artifacts.find((x) => x.kind === "volume")!;
    const volumeB = b.manifest.artifacts.find((x) => x.kind === "volume")!;
    assert.equal(volumeA.id, volumeB.id);

    writeFileSync(
      join(a.directory, "artifacts", `${volumeA.id}.enc`),
      readFileSync(join(b.directory, "artifacts", `${volumeB.id}.enc`))
    );

    const result = await verify(a.directory, { deep: true });
    assert.equal(result.integrity.status, "failed");
  });

  test("a corrupted manifest is reported and authenticity is not evaluated", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    flipByte(join(bundle.directory, "manifest.enc"), 40);

    const result = await verify(bundle.directory);
    assert.equal(result.integrity.status, "failed");
    assert.equal(result.integrity.problems[0]?.code, "MANIFEST_CORRUPT");
    assert.equal(result.authenticity.status, "not-checked");
    assert.equal(result.manifest, null);
  });

  test("wrong passphrase, missing manifest, foreign directory, bad header and future format", async () => {
    const bundle = await buildSyntheticBundle();

    const wrong = await verify(bundle.directory, {}, "a completely different passphrase");
    assert.equal(wrong.integrity.problems[0]?.code, "WRONG_PASSPHRASE");

    const empty = await verify(makeTempDir());
    assert.equal(empty.integrity.problems[0]?.code, "HEADER_INVALID");

    const headerPath = join(bundle.directory, "bundle.header.json");
    const header = JSON.parse(readFileSync(headerPath, "utf8"));

    writeFileSync(headerPath, "{ not json");
    assert.equal((await verify(bundle.directory)).integrity.problems[0]?.code, "HEADER_INVALID");

    writeFileSync(headerPath, JSON.stringify({ ...header, formatVersion: 99 }));
    assert.equal((await verify(bundle.directory)).integrity.problems[0]?.code, "UNSUPPORTED_FORMAT");

    // Substituting the bundleId breaks the authenticated key wrap.
    writeFileSync(headerPath, JSON.stringify({ ...header, bundleId: randomUUID() }));
    assert.equal((await verify(bundle.directory)).integrity.problems[0]?.code, "WRONG_PASSPHRASE");

    writeFileSync(headerPath, JSON.stringify(header));
    rmSync(join(bundle.directory, "manifest.enc"));
    assert.equal((await verify(bundle.directory)).integrity.problems[0]?.code, "INCOMPLETE_EXPORT");
  });
});

describe("bundle verification: authenticity is separate from integrity", () => {
  test("unsigned: integrity verified, authenticity is passphrase-only and says origin is NOT established", async () => {
    const bundle = await buildSyntheticBundle();
    const result = await verify(bundle.directory);

    assert.equal(result.integrity.status, "verified");
    assert.equal(result.authenticity.status, "passphrase-only");
    assert.equal(result.authenticity.signerFingerprint, null);
    assert.match(result.authenticity.notes.join(" "), /NOT established/);
  });

  test("signed but not pinned: still passphrase-only, with an explicit warning", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const result = await verify(bundle.directory);

    assert.equal(result.authenticity.status, "passphrase-only");
    assert.equal(result.authenticity.signerFingerprint, bundle.signer!.fingerprint);
    assert.equal(result.authenticity.pinned, false);
    assert.match(result.authenticity.notes.join(" "), /does NOT establish origin/);
  });

  test("signed and pinned to the right signer: origin-verified (formatting of the pin is forgiving)", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const fingerprint = bundle.signer!.fingerprint;
    const hex = fingerprint.slice("sha256:".length);
    const spaced = hex.match(/.{2}/g)!.join(":").toUpperCase();

    for (const pin of [fingerprint, hex, spaced]) {
      const result = await verify(bundle.directory, { expectedSignerFingerprint: pin });
      assert.equal(result.authenticity.status, "origin-verified", pin);
      assert.equal(result.authenticity.pinned, true);
    }
  });

  test("pinned to a different signer fails, even though the signature itself is valid", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const other = fingerprintOf(generateSigningKeyPair().publicKeyDer);

    const result = await verify(bundle.directory, { expectedSignerFingerprint: other });
    assert.equal(result.integrity.status, "verified");
    assert.equal(result.authenticity.status, "failed");
    assert.match(result.authenticity.notes.join(" "), /NOT the pinned signer/);
  });

  test("a stripped signature cannot silently downgrade a pinned or required check", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const pin = bundle.signer!.fingerprint;
    rmSync(join(bundle.directory, "manifest.sig.json"));

    const pinned = await verify(bundle.directory, { expectedSignerFingerprint: pin });
    assert.equal(pinned.authenticity.status, "failed");
    assert.match(pinned.authenticity.notes.join(" "), /stripped/);

    const required = await verify(bundle.directory, { requireSignature: true });
    assert.equal(required.authenticity.status, "failed");

    assert.equal((await verify(bundle.directory)).authenticity.status, "passphrase-only");
  });

  test("an attacker re-signing with their own key is detected by the pin", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const attacker = generateSigningKeyPair();
    writeFileSync(
      join(bundle.directory, "manifest.sig.json"),
      JSON.stringify(
        signManifest({
          privateKeyPem: attacker.privateKeyPem,
          bundleId: bundle.bundleId,
          manifestSha256: bundle.manifestSha256
        })
      )
    );

    const unpinned = await verify(bundle.directory);
    assert.equal(unpinned.authenticity.status, "passphrase-only"); // the honest answer: proves nothing

    const pinned = await verify(bundle.directory, { expectedSignerFingerprint: bundle.signer!.fingerprint });
    assert.equal(pinned.authenticity.status, "failed");
  });

  test("a tampered or malformed signature is a failure", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    const path = join(bundle.directory, "manifest.sig.json");
    const sig = JSON.parse(readFileSync(path, "utf8"));
    const raw = Buffer.from(sig.signature, "base64");
    raw[0] ^= 1;
    writeFileSync(path, JSON.stringify({ ...sig, signature: raw.toString("base64") }));
    assert.equal((await verify(bundle.directory)).authenticity.status, "failed");

    writeFileSync(path, "{ nope");
    assert.equal((await verify(bundle.directory)).authenticity.status, "failed");
  });

  test("the two properties are independent: valid origin + damaged data, and intact data + no origin", async () => {
    const signed = await buildSyntheticBundle({ signed: true });
    const volume = signed.manifest.artifacts.find((a) => a.kind === "volume")!;
    flipByte(join(signed.directory, "artifacts", `${volume.id}.enc`), 60);

    const damaged = await verify(signed.directory, {
      deep: true,
      expectedSignerFingerprint: signed.signer!.fingerprint
    });
    assert.equal(damaged.authenticity.status, "origin-verified");
    assert.equal(damaged.integrity.status, "failed");

    const intact = await verify((await buildSyntheticBundle()).directory, { deep: true });
    assert.equal(intact.integrity.status, "verified");
    assert.equal(intact.authenticity.status, "passphrase-only");
  });
});

describe("manifest schema and compatibility", () => {
  const base = () =>
    JSON.parse(
      JSON.stringify({
        manifestSchemaVersion: 1,
        bundleId: randomUUID(),
        createdAt: new Date().toISOString(),
        artifacts: [],
        ...sourceBody()
      })
    );

  test("accepts a minimal valid manifest and serializes it deterministically", () => {
    const manifest = parseManifest(base());
    const reordered = JSON.parse(canonicalJson(manifest));

    assert.ok(serializeManifest(manifest).equals(serializeManifest(parseManifest(reordered))));
  });

  test("rejects unknown fields, newer schemas, duplicate and path-like artifact ids", () => {
    assert.throws(() => parseManifest({ ...base(), surprise: 1 }));
    assert.throws(() => parseManifest({ ...base(), manifestSchemaVersion: 2 }), /newer/);

    const artifact = (id: string) => ({
      id,
      kind: "volume",
      subject: "platform",
      plaintextBytes: 0,
      plaintextSha256: "0".repeat(64),
      ciphertextBytes: 38,
      ciphertextSha256: "0".repeat(64),
      meta: {}
    });

    assert.throws(() => parseManifest({ ...base(), artifacts: [artifact("a1"), artifact("a1")] }));
    for (const bad of ["../x", "a/b", "A1", "manifest", "a b"]) {
      assert.throws(
        () => parseManifest({ ...base(), artifacts: [artifact(bad)] }),
        (error: unknown) => error instanceof Error,
        bad
      );
    }
  });

  test("rejects references to artifacts that are not listed, and empty application-scope bundles", () => {
    const app = {
      ref: "app:1",
      sourceAppId: 1,
      name: "x",
      containerName: "app-x",
      image: "nginx",
      domain: null,
      internalOnly: false,
      desiredStatus: "running",
      volumes: [
        {
          name: "v",
          containerPath: "/d",
          readOnly: false,
          artifactId: "a0009",
          sizeBytes: null,
          consistency: { level: "crash-consistent", strategy: "freeze", evidence: [] }
        }
      ],
      images: [],
      dependsOn: [],
      dormantOnImport: false
    };

    assert.throws(() => parseManifest({ ...base(), apps: [app] }), /not listed/);
    assert.throws(() => parseManifest({ ...base(), scope: "application", apps: [] }), /at least one app/);
  });

  test("compatibility: downgrade, version skew and architecture are judged per scope", async () => {
    const bundle = await buildSyntheticBundle();
    const target = {
      platformVersion: "1.9.0",
      schemaVersion: 28,
      arch: "x64",
      supportedFormatVersions: [1]
    };

    assert.deepEqual(checkManifestCompatibility(bundle.manifest, target), []);

    const older = checkManifestCompatibility(bundle.manifest, { ...target, schemaVersion: 20 });
    assert.equal(older[0]?.code, "schema-newer-than-target");
    assert.equal(older[0]?.severity, "fail");

    const newerPlatform = checkManifestCompatibility(bundle.manifest, { ...target, platformVersion: "1.8.0" });
    assert.equal(newerPlatform.find((i) => i.code === "platform-newer-than-target")?.severity, "fail");

    const appScope = { ...bundle.manifest, scope: "application" as const };
    const appIssue = checkManifestCompatibility(appScope, { ...target, platformVersion: "1.8.0" });
    assert.equal(appIssue.find((i) => i.code === "platform-newer-than-target")?.severity, "warn");

    const arch = checkManifestCompatibility(bundle.manifest, { ...target, arch: "arm64" });
    assert.equal(arch.find((i) => i.code === "architecture-mismatch")?.severity, "warn"); // no local images

    const withImage = {
      ...bundle.manifest,
      artifacts: [...bundle.manifest.artifacts, { ...bundle.manifest.artifacts[0]!, id: "a0099", kind: "image" as const }]
    };
    assert.equal(
      checkManifestCompatibility(withImage, { ...target, arch: "arm64" }).find((i) => i.code === "architecture-mismatch")
        ?.severity,
      "fail"
    );

    assert.equal(
      checkManifestCompatibility(bundle.manifest, { ...target, supportedFormatVersions: [] })[0]?.code,
      "format-unsupported"
    );

    const dev = checkManifestCompatibility(bundle.manifest, { ...target, platformVersion: "dev" });
    assert.equal(dev.find((i) => i.code === "version-not-comparable")?.severity, "warn");
  });
});
