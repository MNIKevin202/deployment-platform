import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { verifyBundle } from "../migration/bundle.js";
import {
  KDF_MAX_MEMORY_BYTES,
  MAX_HEADER_BYTES,
  MAX_KEY_SLOTS,
  MAX_MANIFEST_BYTES,
  MAX_SIGNATURE_BYTES,
  MIN_CHUNK_SIZE
} from "../migration/constants.js";
import {
  createBundleHeader,
  MigrationCryptoError,
  parseBundleHeader,
  validateKdfParams
} from "../migration/crypto.js";
import {
  buildSyntheticBundle,
  cleanupTempDirs,
  makeTempDir,
  TEST_KDF,
  TEST_PASSPHRASE
} from "./migration-fixtures.js";

after(cleanupTempDirs);

const salt = () => randomBytes(32).toString("base64");
const kdf = (N: number, r: number, p = 1) => ({ algorithm: "scrypt" as const, N, r, p, salt: salt() });

describe("a hostile header cannot make the verifier allocate unbounded memory", () => {
  test("the memory an scrypt derivation would need is capped (N × r, not each alone)", () => {
    assert.equal(KDF_MAX_MEMORY_BYTES, 256 * 1024 * 1024);

    // Each parameter is individually in range, but together they would need 1 GiB.
    assert.throws(() => validateKdfParams(kdf(2 ** 19, 16)), MigrationCryptoError);
    assert.throws(() => validateKdfParams(kdf(2 ** 19, 8)), /more than 256 MiB/);

    // The production default (128 MiB) and the exact boundary (256 MiB) are fine.
    assert.doesNotThrow(() => validateKdfParams(kdf(2 ** 17, 8)));
    assert.doesNotThrow(() => validateKdfParams(kdf(2 ** 19, 4)));
  });

  test("a header cannot carry more key slots than the format allows", async () => {
    const { header } = await createBundleHeader({ passphrase: TEST_PASSPHRASE, chunkSize: MIN_CHUNK_SIZE, kdf: TEST_KDF });
    const slot = header.keySlots[0]!;
    const withSlots = (count: number) => ({
      ...header,
      keySlots: Array.from({ length: count }, (_, index) => ({ ...slot, id: `ks-${index + 1}` }))
    });

    assert.doesNotThrow(() => parseBundleHeader(withSlots(MAX_KEY_SLOTS)));
    assert.throws(() => parseBundleHeader(withSlots(MAX_KEY_SLOTS + 1)));
  });
});

describe("untrusted bundle files are size-checked before they are read", () => {
  test("an oversized header is rejected as malformed", async () => {
    const bundle = await buildSyntheticBundle();
    writeFileSync(join(bundle.directory, "bundle.header.json"), Buffer.alloc(MAX_HEADER_BYTES + 1, 0x20));

    const result = await verifyBundle(bundle.directory, TEST_PASSPHRASE);
    assert.equal(result.integrity.problems[0]?.code, "HEADER_INVALID");
    assert.match(result.integrity.problems[0]!.message, /larger than the format allows/);
  });

  test("an oversized manifest is rejected without being decrypted", async () => {
    const bundle = await buildSyntheticBundle();
    writeFileSync(join(bundle.directory, "manifest.enc"), Buffer.alloc(MAX_MANIFEST_BYTES + 1));

    const result = await verifyBundle(bundle.directory, TEST_PASSPHRASE);
    assert.equal(result.integrity.status, "failed");
    assert.equal(result.integrity.problems[0]?.code, "MANIFEST_CORRUPT");
    assert.equal(result.authenticity.status, "not-checked");
  });

  test("an oversized signature file is a signature failure, not a memory problem", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });
    writeFileSync(join(bundle.directory, "manifest.sig.json"), Buffer.alloc(MAX_SIGNATURE_BYTES + 1, 0x20));

    const result = await verifyBundle(bundle.directory, TEST_PASSPHRASE);
    assert.equal(result.integrity.status, "verified"); // the data is fine...
    assert.equal(result.authenticity.status, "failed"); // ...but the signature file is not acceptable
  });

  test("limits are not applied to a normal bundle", async () => {
    const bundle = await buildSyntheticBundle({ signed: true });

    assert.ok(readFileSync(join(bundle.directory, "bundle.header.json")).length < MAX_HEADER_BYTES);
    assert.equal((await verifyBundle(bundle.directory, TEST_PASSPHRASE, { deep: true })).integrity.status, "verified");
  });
});

describe("only plain files are accepted inside a bundle (runs on every platform)", () => {
  test("a directory standing in for an artifact, the header or the manifest is rejected", async () => {
    const artifactCase = await buildSyntheticBundle();
    const volume = artifactCase.manifest.artifacts.find((artifact) => artifact.kind === "volume")!;
    const artifactPath = join(artifactCase.directory, "artifacts", `${volume.id}.enc`);
    rmSync(artifactPath);
    mkdirSync(artifactPath);
    for (const deep of [false, true]) {
      const result = await verifyBundle(artifactCase.directory, TEST_PASSPHRASE, { deep });
      assert.equal(result.integrity.status, "failed", `deep=${deep}`);
      assert.match(result.integrity.problems.map((problem) => problem.message).join(" "), /not a regular file/);
    }

    const headerCase = await buildSyntheticBundle();
    rmSync(join(headerCase.directory, "bundle.header.json"));
    mkdirSync(join(headerCase.directory, "bundle.header.json"));
    assert.equal((await verifyBundle(headerCase.directory, TEST_PASSPHRASE)).integrity.problems[0]?.code, "HEADER_INVALID");

    const manifestCase = await buildSyntheticBundle();
    rmSync(join(manifestCase.directory, "manifest.enc"));
    mkdirSync(join(manifestCase.directory, "manifest.enc"));
    assert.equal((await verifyBundle(manifestCase.directory, TEST_PASSPHRASE)).integrity.problems[0]?.code, "MANIFEST_CORRUPT");
  });
});

describe("symbolic links inside a bundle are never followed", { skip: process.platform === "win32" }, () => {
  test("an artifact replaced by a symlink to another file is rejected", async () => {
    const bundle = await buildSyntheticBundle();
    const volume = bundle.manifest.artifacts.find((artifact) => artifact.kind === "volume")!;
    const elsewhere = join(makeTempDir(), "elsewhere");
    writeFileSync(elsewhere, randomBytes(volume.ciphertextBytes));

    const artifact = join(bundle.directory, "artifacts", `${volume.id}.enc`);
    rmSync(artifact);
    symlinkSync(elsewhere, artifact);

    for (const deep of [false, true]) {
      const result = await verifyBundle(bundle.directory, TEST_PASSPHRASE, { deep });
      assert.equal(result.integrity.status, "failed", `deep=${deep}`);
      assert.match(result.integrity.problems.map((problem) => problem.message).join(" "), /not a regular file/);
    }
  });

  test("a symlinked header or manifest is rejected", async () => {
    const header = await buildSyntheticBundle();
    const target = join(makeTempDir(), "header.json");
    writeFileSync(target, readFileSync(join(header.directory, "bundle.header.json")));
    rmSync(join(header.directory, "bundle.header.json"));
    symlinkSync(target, join(header.directory, "bundle.header.json"));
    assert.equal((await verifyBundle(header.directory, TEST_PASSPHRASE)).integrity.problems[0]?.code, "HEADER_INVALID");

    const manifest = await buildSyntheticBundle();
    const sealed = join(makeTempDir(), "manifest.enc");
    writeFileSync(sealed, readFileSync(join(manifest.directory, "manifest.enc")));
    rmSync(join(manifest.directory, "manifest.enc"));
    symlinkSync(sealed, join(manifest.directory, "manifest.enc"));
    assert.equal((await verifyBundle(manifest.directory, TEST_PASSPHRASE)).integrity.problems[0]?.code, "MANIFEST_CORRUPT");
  });
});
