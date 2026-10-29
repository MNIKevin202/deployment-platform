import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MIN_CHUNK_SIZE, STREAM_HEADER_BYTES } from "../migration/constants.js";
import {
  ArtifactDecryptStream,
  ArtifactEncryptStream,
  createBundleHeader,
  generateBundleKey,
  IntegrityError,
  MigrationCryptoError,
  normalizePassphrase,
  openBuffer,
  parseBundleHeader,
  sealBuffer,
  UnsupportedBundleError,
  unwrapBundleKey,
  validateKdfParams,
  WrongPassphraseError,
  type StreamContext
} from "../migration/crypto.js";

const CHUNK = MIN_CHUNK_SIZE; // 64 KiB keeps these tests fast
const CHEAP_KDF = { N: 2 ** 14, r: 8, p: 1 };
const PASSPHRASE = "correct horse battery staple";

function context(overrides: Partial<StreamContext> = {}): StreamContext {
  return {
    bundleKey: Buffer.alloc(32, 7),
    bundleId: "11111111-1111-4111-8111-111111111111",
    artifactId: "a0001",
    chunkSize: CHUNK,
    ...overrides
  };
}

const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

async function rejectsWithIntegrity(promise: Promise<unknown>, code?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof IntegrityError, `expected IntegrityError, got ${String(error)}`);
    if (code) {
      assert.equal((error as IntegrityError).code, code);
    }
    return true;
  });
}

describe("artifact stream: round trip", () => {
  const sizes = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 7];

  for (const size of sizes) {
    test(`round-trips ${size} bytes with the expected ciphertext length and hashes`, async () => {
      const plaintext = randomBytes(size);
      const { ciphertext, stats } = await sealBuffer(plaintext, context());
      const chunks = Math.max(1, Math.ceil(size / CHUNK));

      assert.equal(ciphertext.length, STREAM_HEADER_BYTES + size + 16 * chunks);
      assert.equal(stats.plaintextBytes, size);
      assert.equal(stats.plaintextSha256, sha(plaintext));
      assert.equal(stats.ciphertextBytes, ciphertext.length);
      assert.equal(stats.ciphertextSha256, sha(ciphertext));

      const opened = await openBuffer(ciphertext, context());
      assert.ok(opened.plaintext.equals(plaintext));
      assert.equal(opened.stats.plaintextSha256, stats.plaintextSha256);
      assert.equal(opened.stats.ciphertextSha256, stats.ciphertextSha256);
    });
  }

  test("is independent of how the input is split into writes", async () => {
    const plaintext = randomBytes(2 * CHUNK + 123);
    const pieces: Buffer[] = [];
    for (let offset = 0; offset < plaintext.length; offset += 4097) {
      pieces.push(plaintext.subarray(offset, offset + 4097));
    }

    const encrypt = new ArtifactEncryptStream(context());
    const out: Buffer[] = [];
    await pipeline(
      Readable.from(pieces),
      encrypt,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          out.push(chunk);
          cb();
        }
      })
    );

    const opened = await openBuffer(Buffer.concat(out), context());
    assert.ok(opened.plaintext.equals(plaintext));
  });

  test("decrypts correctly when ciphertext arrives in tiny pieces", async () => {
    const plaintext = randomBytes(CHUNK + 50);
    const { ciphertext } = await sealBuffer(plaintext, context());
    const pieces: Buffer[] = [];
    for (let offset = 0; offset < ciphertext.length; offset += 1000) {
      pieces.push(ciphertext.subarray(offset, offset + 1000));
    }

    const decrypt = new ArtifactDecryptStream(context());
    const out: Buffer[] = [];
    await pipeline(
      Readable.from(pieces),
      decrypt,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          out.push(chunk);
          cb();
        }
      })
    );

    assert.ok(Buffer.concat(out).equals(plaintext));
  });

  test("two encryptions of the same data differ (random per-file salt)", async () => {
    const plaintext = randomBytes(1000);
    const a = await sealBuffer(plaintext, context());
    const b = await sealBuffer(plaintext, context());

    assert.ok(!a.ciphertext.equals(b.ciphertext));
    assert.equal(a.stats.plaintextSha256, b.stats.plaintextSha256);
  });

  test("statistics are unavailable until the stream has finished", () => {
    assert.throws(() => new ArtifactEncryptStream(context()).stats(), MigrationCryptoError);
    assert.throws(() => new ArtifactDecryptStream(context()).stats(), MigrationCryptoError);
  });
});

describe("artifact stream: tamper evidence", () => {
  const plaintext = randomBytes(3 * CHUNK + 10); // 4 chunks

  async function sealed(): Promise<Buffer> {
    return (await sealBuffer(plaintext, context())).ciphertext;
  }

  test("flipping a bit anywhere in the body or a tag is detected", async () => {
    const ciphertext = await sealed();
    const positions = [
      STREAM_HEADER_BYTES, // first body byte
      STREAM_HEADER_BYTES + CHUNK + 16 + 5, // second chunk body
      STREAM_HEADER_BYTES + CHUNK - 1, // last body byte of chunk 0
      STREAM_HEADER_BYTES + CHUNK, // first tag byte of chunk 0
      ciphertext.length - 1 // final tag
    ];

    for (const position of positions) {
      const copy = Buffer.from(ciphertext);
      copy[position] ^= 0x01;
      await rejectsWithIntegrity(openBuffer(copy, context()), "AUTHENTICATION_FAILED");
    }
  });

  test("altering the stream header is detected", async () => {
    const ciphertext = await sealed();

    const badMagic = Buffer.from(ciphertext);
    badMagic[0] ^= 0xff;
    await rejectsWithIntegrity(openBuffer(badMagic, context()), "BAD_MAGIC");

    const badVersion = Buffer.from(ciphertext);
    badVersion[4] = 9;
    await rejectsWithIntegrity(openBuffer(badVersion, context()), "UNSUPPORTED_STREAM_VERSION");

    const badChunk = Buffer.from(ciphertext);
    badChunk[5] = badChunk[5]! + 1;
    await rejectsWithIntegrity(openBuffer(badChunk, context()), "BAD_CHUNK_SIZE");

    const badSalt = Buffer.from(ciphertext);
    badSalt[10] ^= 0x01; // changes the derived key
    await rejectsWithIntegrity(openBuffer(badSalt, context()), "AUTHENTICATION_FAILED");
  });

  test("truncating exactly at a chunk boundary is detected (final-flag nonce)", async () => {
    const ciphertext = await sealed();
    const block = CHUNK + 16;

    for (const keptChunks of [1, 2, 3]) {
      const truncated = ciphertext.subarray(0, STREAM_HEADER_BYTES + keptChunks * block);
      await rejectsWithIntegrity(openBuffer(truncated, context()));
    }
  });

  test("truncating mid-chunk, to the header, or to nothing is detected", async () => {
    const ciphertext = await sealed();

    await rejectsWithIntegrity(openBuffer(ciphertext.subarray(0, ciphertext.length - 5), context()));
    await rejectsWithIntegrity(
      openBuffer(ciphertext.subarray(0, STREAM_HEADER_BYTES), context()),
      "TRUNCATED"
    );
    await rejectsWithIntegrity(openBuffer(Buffer.alloc(0), context()), "TRUNCATED");
    await rejectsWithIntegrity(openBuffer(ciphertext.subarray(0, 10), context()), "TRUNCATED");
  });

  test("appending data after the final chunk is detected", async () => {
    const ciphertext = await sealed();

    await rejectsWithIntegrity(
      openBuffer(Buffer.concat([ciphertext, randomBytes(40)]), context()),
      "AUTHENTICATION_FAILED"
    );
    await rejectsWithIntegrity(openBuffer(Buffer.concat([ciphertext, Buffer.from([0])]), context()));
  });

  test("reordering or duplicating chunks is detected (counter is in the nonce)", async () => {
    const ciphertext = await sealed();
    const block = CHUNK + 16;
    const header = ciphertext.subarray(0, STREAM_HEADER_BYTES);
    const chunk = (index: number): Buffer =>
      ciphertext.subarray(STREAM_HEADER_BYTES + index * block, STREAM_HEADER_BYTES + (index + 1) * block);
    const last = ciphertext.subarray(STREAM_HEADER_BYTES + 3 * block);

    const swapped = Buffer.concat([header, chunk(1), chunk(0), chunk(2), last]);
    await rejectsWithIntegrity(openBuffer(swapped, context()), "AUTHENTICATION_FAILED");

    const duplicated = Buffer.concat([header, chunk(0), chunk(0), chunk(1), chunk(2), last]);
    await rejectsWithIntegrity(openBuffer(duplicated, context()), "AUTHENTICATION_FAILED");

    const dropped = Buffer.concat([header, chunk(0), chunk(2), last]);
    await rejectsWithIntegrity(openBuffer(dropped, context()), "AUTHENTICATION_FAILED");
  });

  test("an artifact cannot be moved to another id, another bundle, or opened with another key", async () => {
    const ciphertext = await sealed();

    await rejectsWithIntegrity(openBuffer(ciphertext, context({ artifactId: "a0002" })));
    await rejectsWithIntegrity(
      openBuffer(ciphertext, context({ bundleId: "22222222-2222-4222-8222-222222222222" }))
    );
    await rejectsWithIntegrity(openBuffer(ciphertext, context({ bundleKey: Buffer.alloc(32, 8) })));
  });

  test("a mismatched configured chunk size is rejected", async () => {
    const ciphertext = await sealed();

    await rejectsWithIntegrity(
      openBuffer(ciphertext, context({ chunkSize: CHUNK * 2 })),
      "BAD_CHUNK_SIZE"
    );
  });

  test("chunk sizes outside the allowed range are refused up front", () => {
    assert.throws(() => new ArtifactEncryptStream(context({ chunkSize: 1000 })), MigrationCryptoError);
    assert.throws(() => new ArtifactEncryptStream(context({ chunkSize: CHUNK + 1 })), MigrationCryptoError);
  });
});

describe("passphrase and key wrapping", () => {
  test("normalizePassphrase enforces the minimum length and NFKC form", () => {
    assert.throws(() => normalizePassphrase("short"), MigrationCryptoError);
    assert.equal(normalizePassphrase("é".repeat(12)), "é".repeat(12));
  });

  test("a bundle key unwraps with the right passphrase only", async () => {
    const { header, bundleKey } = await createBundleHeader({
      passphrase: PASSPHRASE,
      chunkSize: CHUNK,
      kdf: CHEAP_KDF
    });

    const unwrapped = await unwrapBundleKey(header, PASSPHRASE);
    assert.ok(unwrapped.bundleKey.equals(bundleKey));
    assert.equal(unwrapped.slotId, "ks-1");

    await assert.rejects(unwrapBundleKey(header, "a completely different passphrase"), WrongPassphraseError);
    await assert.rejects(unwrapBundleKey(header, "short"), MigrationCryptoError);
  });

  test("equivalent Unicode normalisations of a passphrase both unwrap", async () => {
    const decomposed = "café passphrase!";
    const composed = "café passphrase!";
    const { header } = await createBundleHeader({ passphrase: decomposed, chunkSize: CHUNK, kdf: CHEAP_KDF });

    await unwrapBundleKey(header, composed);
  });

  test("the header is authenticated: substituting fields breaks the unwrap", async () => {
    const { header } = await createBundleHeader({ passphrase: PASSPHRASE, chunkSize: CHUNK, kdf: CHEAP_KDF });

    const otherId = { ...header, bundleId: randomUUID() };
    await assert.rejects(unwrapBundleKey(otherId, PASSPHRASE), WrongPassphraseError);

    const otherChunk = { ...header, chunkSize: CHUNK * 2 };
    await assert.rejects(unwrapBundleKey(otherChunk, PASSPHRASE), WrongPassphraseError);

    const otherSlot = { ...header, keySlots: [{ ...header.keySlots[0]!, id: "ks-9" }] };
    await assert.rejects(unwrapBundleKey(otherSlot, PASSPHRASE), WrongPassphraseError);

    const flipped = Buffer.from(header.keySlots[0]!.wrappedKey, "base64");
    flipped[0] ^= 1;
    const otherWrap = {
      ...header,
      keySlots: [{ ...header.keySlots[0]!, wrappedKey: flipped.toString("base64") }]
    };
    await assert.rejects(unwrapBundleKey(otherWrap, PASSPHRASE), WrongPassphraseError);
  });

  test("header validation rejects newer formats, weak or hostile KDF parameters and unknown fields", async () => {
    const { header } = await createBundleHeader({ passphrase: PASSPHRASE, chunkSize: CHUNK, kdf: CHEAP_KDF });

    assert.deepEqual(parseBundleHeader(JSON.parse(JSON.stringify(header))), header);
    assert.throws(() => parseBundleHeader({ ...header, formatVersion: 2 }), UnsupportedBundleError);
    assert.throws(() => parseBundleHeader({ ...header, surprise: true }));
    assert.throws(() => parseBundleHeader({ ...header, chunkSize: 1000 }));

    const withKdf = (patch: Record<string, unknown>) => ({
      ...header,
      keySlots: [{ ...header.keySlots[0]!, kdf: { ...header.keySlots[0]!.kdf, ...patch } }]
    });
    assert.throws(() => parseBundleHeader(withKdf({ N: 2 ** 10 })), MigrationCryptoError); // too weak
    assert.throws(() => parseBundleHeader(withKdf({ N: 2 ** 24 })), MigrationCryptoError); // memory DoS
    assert.throws(() => parseBundleHeader(withKdf({ N: 2 ** 14 + 1 })), MigrationCryptoError); // not a power of 2
    assert.throws(() => parseBundleHeader(withKdf({ r: 64 })), MigrationCryptoError);
    assert.throws(() => parseBundleHeader(withKdf({ p: 64 })), MigrationCryptoError);
    assert.throws(() => parseBundleHeader(withKdf({ salt: "AAAA" })), MigrationCryptoError);
  });

  test("validateKdfParams accepts the production default", () => {
    const kdf = validateKdfParams({
      algorithm: "scrypt",
      N: 2 ** 17,
      r: 8,
      p: 1,
      salt: randomBytes(32).toString("base64")
    });

    assert.equal(kdf.N, 2 ** 17);
  });

  test("bundle keys are 32 random bytes", () => {
    const a = generateBundleKey();
    const b = generateBundleKey();

    assert.equal(a.length, 32);
    assert.ok(!a.equals(b));
  });
});
