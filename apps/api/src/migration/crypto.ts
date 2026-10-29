import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback
} from "node:crypto";
import { Readable, Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  BUNDLE_KEY_BYTES,
  CIPHER_ID,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_KDF,
  GCM_NONCE_BYTES,
  GCM_TAG_BYTES,
  KDF_MAX_MEMORY_BYTES,
  KDF_MAX_N,
  KDF_MAX_P,
  KDF_MAX_R,
  KDF_MIN_N,
  KDF_SALT_BYTES,
  MAX_CHUNK_SIZE,
  MAX_KEY_SLOTS,
  MIN_CHUNK_SIZE,
  MIN_PASSPHRASE_LENGTH,
  STREAM_HEADER_BYTES,
  STREAM_MAGIC,
  STREAM_SALT_BYTES,
  STREAM_VERSION
} from "./constants.js";

/**
 * Cryptographic core of the migration bundle. The scheme is specified in
 * docs/MIGRATION_BUNDLE_FORMAT.md; this file is its only implementation.
 *
 *   passphrase --scrypt--> KEK --AES-GCM wrap--> bundle key (random, per bundle)
 *   bundle key --HKDF(per-file salt, bundleId, artifactId)--> artifact key
 *   artifact key --AES-256-GCM, chunked, counter+final-flag nonce--> stream
 */

// ---------------------------------------------------------------- errors ----

export type IntegrityErrorCode =
  | "BAD_MAGIC"
  | "UNSUPPORTED_STREAM_VERSION"
  | "BAD_CHUNK_SIZE"
  | "TRUNCATED"
  | "AUTHENTICATION_FAILED"
  | "MANIFEST_MISMATCH";

/** A stream failed an integrity check. The data must not be trusted. */
export class IntegrityError extends Error {
  readonly code: IntegrityErrorCode;

  constructor(code: IntegrityErrorCode, message: string) {
    super(message);
    this.name = "IntegrityError";
    this.code = code;
  }
}

/**
 * The bundle key could not be unwrapped. A wrong passphrase and a tampered
 * header are deliberately indistinguishable.
 */
export class WrongPassphraseError extends Error {
  constructor() {
    super("The passphrase is wrong, or the bundle header has been modified.");
    this.name = "WrongPassphraseError";
  }
}

export class MigrationCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationCryptoError";
  }
}

// ------------------------------------------------------------ passphrase ----

/** NFKC-normalises and length-checks a passphrase. Never logs it. */
export function normalizePassphrase(passphrase: string): string {
  const normalized = passphrase.normalize("NFKC");

  if ([...normalized].length < MIN_PASSPHRASE_LENGTH) {
    throw new MigrationCryptoError(
      `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long.`
    );
  }

  return normalized;
}

// ------------------------------------------------------------------- KDF ----

export interface KdfParams {
  algorithm: "scrypt";
  N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
}

export interface KdfCost {
  N: number;
  r: number;
  p: number;
}

const kdfSchema = z.strictObject({
  algorithm: z.literal("scrypt"),
  N: z.number().int(),
  r: z.number().int(),
  p: z.number().int(),
  salt: z.string().min(1)
});

/** Validates header-supplied KDF parameters against the floor/ceiling. */
export function validateKdfParams(input: unknown): KdfParams {
  const kdf = kdfSchema.parse(input);

  const isPowerOfTwo = kdf.N > 0 && (kdf.N & (kdf.N - 1)) === 0;
  if (!isPowerOfTwo || kdf.N < KDF_MIN_N || kdf.N > KDF_MAX_N) {
    throw new MigrationCryptoError(
      `KDF parameter N must be a power of two between ${KDF_MIN_N} and ${KDF_MAX_N}.`
    );
  }
  if (kdf.r < 1 || kdf.r > KDF_MAX_R || kdf.p < 1 || kdf.p > KDF_MAX_P) {
    throw new MigrationCryptoError("KDF parameters r/p are out of range.");
  }
  if (128 * kdf.N * kdf.r > KDF_MAX_MEMORY_BYTES) {
    throw new MigrationCryptoError(
      `KDF parameters would need more than ${KDF_MAX_MEMORY_BYTES / (1024 * 1024)} MiB of memory.`
    );
  }
  if (Buffer.from(kdf.salt, "base64").length < 16) {
    throw new MigrationCryptoError("KDF salt is too short.");
  }

  return kdf;
}

export function deriveKek(passphrase: string, kdf: KdfParams): Promise<Buffer> {
  const validated = validateKdfParams(kdf);
  const normalized = normalizePassphrase(passphrase);

  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      normalized,
      Buffer.from(validated.salt, "base64"),
      32,
      {
        N: validated.N,
        r: validated.r,
        p: validated.p,
        maxmem: 256 * validated.N * validated.r + (1 << 20)
      },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey))
    );
  });
}

// ------------------------------------------------------- header / key slot ----

export interface PassphraseKeySlot {
  type: "passphrase";
  id: string;
  kdf: KdfParams;
  /** base64, 12 bytes */
  nonce: string;
  /** base64, the wrapped 32-byte bundle key */
  wrappedKey: string;
  /** base64, 16 bytes */
  tag: string;
}

export interface BundleHeader {
  format: typeof BUNDLE_FORMAT;
  formatVersion: number;
  bundleId: string;
  cipher: typeof CIPHER_ID;
  chunkSize: number;
  keySlots: PassphraseKeySlot[];
}

const keySlotSchema = z.strictObject({
  type: z.literal("passphrase"),
  id: z.string().min(1).max(32),
  kdf: kdfSchema,
  nonce: z.string().min(1),
  wrappedKey: z.string().min(1),
  tag: z.string().min(1)
});

const headerSchema = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  formatVersion: z.number().int().positive(),
  bundleId: z.uuid(),
  cipher: z.literal(CIPHER_ID),
  chunkSize: z.number().int(),
  keySlots: z.array(keySlotSchema).min(1).max(MAX_KEY_SLOTS)
});

export class UnsupportedBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedBundleError";
  }
}

/** Parses and validates a header. Rejects newer format versions outright. */
export function parseBundleHeader(input: unknown): BundleHeader {
  const header = headerSchema.parse(input) as BundleHeader;

  if (header.formatVersion > BUNDLE_FORMAT_VERSION) {
    throw new UnsupportedBundleError(
      `Bundle format version ${header.formatVersion} is newer than this ClovaForge supports ` +
        `(${BUNDLE_FORMAT_VERSION}). Upgrade this server before importing.`
    );
  }
  assertChunkSize(header.chunkSize);
  for (const slot of header.keySlots) {
    validateKdfParams(slot.kdf);
  }

  return header;
}

function assertChunkSize(chunkSize: number): void {
  const isPowerOfTwo = chunkSize > 0 && (chunkSize & (chunkSize - 1)) === 0;
  if (!isPowerOfTwo || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new MigrationCryptoError(
      `Chunk size must be a power of two between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}.`
    );
  }
}

function keyWrapAad(
  context: { bundleId: string; chunkSize: number },
  slotId: string,
  kdf: KdfParams
): Buffer {
  return Buffer.from(
    `cfmig-keywrap-v1\0${canonicalJson({
      format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_FORMAT_VERSION,
      bundleId: context.bundleId,
      cipher: CIPHER_ID,
      chunkSize: context.chunkSize,
      slotId,
      kdf
    })}`,
    "utf8"
  );
}

export function generateBundleKey(): Buffer {
  return randomBytes(BUNDLE_KEY_BYTES);
}

export interface CreateKeySlotOptions {
  bundleKey: Buffer;
  passphrase: string;
  bundleId: string;
  chunkSize: number;
  slotId?: string;
  kdf?: KdfCost;
}

/** Wraps the bundle key under a passphrase-derived KEK. */
export async function createPassphraseKeySlot(
  options: CreateKeySlotOptions
): Promise<PassphraseKeySlot> {
  if (options.bundleKey.length !== BUNDLE_KEY_BYTES) {
    throw new MigrationCryptoError("The bundle key must be exactly 32 bytes.");
  }

  const slotId = options.slotId ?? "ks-1";
  const cost = options.kdf ?? DEFAULT_KDF;
  const kdf: KdfParams = validateKdfParams({
    algorithm: "scrypt",
    N: cost.N,
    r: cost.r,
    p: cost.p,
    salt: randomBytes(KDF_SALT_BYTES).toString("base64")
  });

  const kek = await deriveKek(options.passphrase, kdf);
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(keyWrapAad(options, slotId, kdf));
  const wrapped = Buffer.concat([cipher.update(options.bundleKey), cipher.final()]);

  return {
    type: "passphrase",
    id: slotId,
    kdf,
    nonce: nonce.toString("base64"),
    wrappedKey: wrapped.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

/** Recovers the bundle key. Throws WrongPassphraseError on any failure. */
export async function unwrapBundleKey(
  header: BundleHeader,
  passphrase: string
): Promise<{ bundleKey: Buffer; slotId: string }> {
  for (const slot of header.keySlots) {
    try {
      const kek = await deriveKek(passphrase, slot.kdf);
      const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(slot.nonce, "base64"), {
        authTagLength: GCM_TAG_BYTES
      });
      decipher.setAAD(keyWrapAad(header, slot.id, slot.kdf));
      decipher.setAuthTag(Buffer.from(slot.tag, "base64"));
      const bundleKey = Buffer.concat([
        decipher.update(Buffer.from(slot.wrappedKey, "base64")),
        decipher.final()
      ]);

      if (bundleKey.length === BUNDLE_KEY_BYTES) {
        return { bundleKey, slotId: slot.id };
      }
    } catch (error) {
      if (error instanceof MigrationCryptoError) {
        // A too-short passphrase is a usage error, not a wrong-passphrase result.
        throw error;
      }
      // Authentication failure on this slot — try the next one.
    }
  }

  throw new WrongPassphraseError();
}

/** Creates a header plus the bundle key that its single passphrase slot wraps. */
export async function createBundleHeader(options: {
  passphrase: string;
  chunkSize?: number;
  kdf?: KdfCost;
  bundleId?: string;
}): Promise<{ header: BundleHeader; bundleKey: Buffer }> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  assertChunkSize(chunkSize);

  const bundleId = options.bundleId ?? randomUUID();
  const bundleKey = generateBundleKey();
  const slot = await createPassphraseKeySlot({
    bundleKey,
    passphrase: options.passphrase,
    bundleId,
    chunkSize,
    kdf: options.kdf
  });

  const header: BundleHeader = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    bundleId,
    cipher: CIPHER_ID,
    chunkSize,
    keySlots: [slot]
  };

  return { header, bundleKey };
}

// --------------------------------------------------------- artifact stream ----

export interface StreamContext {
  bundleKey: Buffer;
  bundleId: string;
  artifactId: string;
  chunkSize: number;
}

export interface StreamStats {
  plaintextBytes: number;
  plaintextSha256: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
}

function deriveArtifactKey(context: StreamContext, salt: Buffer): Buffer {
  const info = Buffer.from(
    `cfmig-artifact-v1\0${context.bundleId}\0${context.artifactId}`,
    "utf8"
  );

  return Buffer.from(hkdfSync("sha256", context.bundleKey, salt, info, 32));
}

function chunkNonce(counter: number, isFinal: boolean): Buffer {
  const nonce = Buffer.alloc(GCM_NONCE_BYTES);
  // 11-byte big-endian counter occupies bytes 0..10; the low 8 bytes are written.
  nonce.writeBigUInt64BE(BigInt(counter), 3);
  nonce[GCM_NONCE_BYTES - 1] = isFinal ? 1 : 0;

  return nonce;
}

function chunkAad(context: StreamContext, streamHeader: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`cfmig-chunk-v1\0${context.bundleId}\0${context.artifactId}\0`, "utf8"),
    streamHeader
  ]);
}

function log2Exact(value: number): number {
  return Math.round(Math.log2(value));
}

/** Plaintext in, encrypted artifact stream out. */
export class ArtifactEncryptStream extends Transform {
  private readonly context: StreamContext;
  private readonly streamHeader: Buffer;
  private readonly key: Buffer;
  private readonly aad: Buffer;
  private parts: Buffer[] = [];
  private partsLength = 0;
  private counter = 0;
  private started = false;
  private finished = false;
  private plaintextBytes = 0;
  private ciphertextBytes = 0;
  private readonly plaintextHash = createHash("sha256");
  private readonly ciphertextHash = createHash("sha256");

  constructor(context: StreamContext) {
    super();
    assertChunkSize(context.chunkSize);
    this.context = context;

    const salt = randomBytes(STREAM_SALT_BYTES);
    this.streamHeader = Buffer.concat([
      STREAM_MAGIC,
      Buffer.from([STREAM_VERSION, log2Exact(context.chunkSize)]),
      salt
    ]);
    this.key = deriveArtifactKey(context, salt);
    this.aad = chunkAad(context, this.streamHeader);
  }

  stats(): StreamStats {
    if (!this.finished) {
      throw new MigrationCryptoError("The stream has not finished; statistics are not final.");
    }

    return {
      plaintextBytes: this.plaintextBytes,
      plaintextSha256: this.plaintextHash.copy().digest("hex"),
      ciphertextBytes: this.ciphertextBytes,
      ciphertextSha256: this.ciphertextHash.copy().digest("hex")
    };
  }

  private writeOut(buffer: Buffer): void {
    this.ciphertextHash.update(buffer);
    this.ciphertextBytes += buffer.length;
    this.push(buffer);
  }

  private start(): void {
    if (!this.started) {
      this.started = true;
      this.writeOut(this.streamHeader);
    }
  }

  private seal(plaintext: Buffer, isFinal: boolean): void {
    const cipher = createCipheriv("aes-256-gcm", this.key, chunkNonce(this.counter, isFinal), {
      authTagLength: GCM_TAG_BYTES
    });
    cipher.setAAD(this.aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    this.counter += 1;
    this.writeOut(Buffer.concat([body, cipher.getAuthTag()]));
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.start();
      this.plaintextHash.update(chunk);
      this.plaintextBytes += chunk.length;
      this.parts.push(chunk);
      this.partsLength += chunk.length;

      // Strictly greater: the final chunk is held back until we know it is last.
      if (this.partsLength > this.context.chunkSize) {
        const all = Buffer.concat(this.parts);
        let offset = 0;

        while (all.length - offset > this.context.chunkSize) {
          this.seal(all.subarray(offset, offset + this.context.chunkSize), false);
          offset += this.context.chunkSize;
        }

        const rest = all.subarray(offset);
        this.parts = [rest];
        this.partsLength = rest.length;
      }

      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.start();
      this.seal(Buffer.concat(this.parts), true);
      this.parts = [];
      this.partsLength = 0;
      this.finished = true;
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

/** Encrypted artifact stream in, authenticated plaintext out. */
export class ArtifactDecryptStream extends Transform {
  private readonly context: StreamContext;
  private readonly blockSize: number;
  private pending: Buffer = Buffer.alloc(0);
  private key: Buffer | null = null;
  private aad: Buffer | null = null;
  private counter = 0;
  private finished = false;
  private plaintextBytes = 0;
  private ciphertextBytes = 0;
  private readonly plaintextHash = createHash("sha256");
  private readonly ciphertextHash = createHash("sha256");

  constructor(context: StreamContext) {
    super();
    assertChunkSize(context.chunkSize);
    this.context = context;
    this.blockSize = context.chunkSize + GCM_TAG_BYTES;
  }

  stats(): StreamStats {
    if (!this.finished) {
      throw new MigrationCryptoError("The stream has not finished; statistics are not final.");
    }

    return {
      plaintextBytes: this.plaintextBytes,
      plaintextSha256: this.plaintextHash.copy().digest("hex"),
      ciphertextBytes: this.ciphertextBytes,
      ciphertextSha256: this.ciphertextHash.copy().digest("hex")
    };
  }

  private readHeader(): boolean {
    if (this.key) {
      return true;
    }
    if (this.pending.length < STREAM_HEADER_BYTES) {
      return false;
    }

    const header = this.pending.subarray(0, STREAM_HEADER_BYTES);

    if (!header.subarray(0, 4).equals(STREAM_MAGIC)) {
      throw new IntegrityError("BAD_MAGIC", "Not a ClovaForge migration artifact stream.");
    }
    if (header[4] !== STREAM_VERSION) {
      throw new IntegrityError(
        "UNSUPPORTED_STREAM_VERSION",
        `Unsupported artifact stream version ${header[4]}.`
      );
    }
    if (header[5] !== log2Exact(this.context.chunkSize)) {
      throw new IntegrityError(
        "BAD_CHUNK_SIZE",
        "The artifact's chunk size does not match the bundle header."
      );
    }

    const salt = Buffer.from(header.subarray(6, 6 + STREAM_SALT_BYTES));
    this.key = deriveArtifactKey(this.context, salt);
    this.aad = chunkAad(this.context, Buffer.from(header));
    this.pending = this.pending.subarray(STREAM_HEADER_BYTES);

    return true;
  }

  private open(block: Buffer, isFinal: boolean): Buffer {
    if (!this.key || !this.aad) {
      throw new IntegrityError("TRUNCATED", "The artifact stream has no header.");
    }
    if (block.length < GCM_TAG_BYTES) {
      throw new IntegrityError("TRUNCATED", "The artifact stream ends inside a chunk.");
    }

    const body = block.subarray(0, block.length - GCM_TAG_BYTES);
    const tag = block.subarray(block.length - GCM_TAG_BYTES);

    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        chunkNonce(this.counter, isFinal),
        { authTagLength: GCM_TAG_BYTES }
      );
      decipher.setAAD(this.aad);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
      this.counter += 1;
      this.plaintextHash.update(plaintext);
      this.plaintextBytes += plaintext.length;

      return plaintext;
    } catch {
      throw new IntegrityError(
        "AUTHENTICATION_FAILED",
        "An artifact chunk failed authentication: the data is corrupt, truncated, reordered or " +
          "does not belong to this bundle."
      );
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.ciphertextHash.update(chunk);
      this.ciphertextBytes += chunk.length;
      this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

      if (!this.readHeader()) {
        callback();
        return;
      }

      // Strictly greater: the trailing block might be the final one.
      while (this.pending.length > this.blockSize) {
        const plaintext = this.open(this.pending.subarray(0, this.blockSize), false);
        this.pending = this.pending.subarray(this.blockSize);
        this.push(plaintext);
      }

      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (!this.readHeader()) {
        throw new IntegrityError("TRUNCATED", "The artifact stream ends before its header.");
      }

      this.push(this.open(this.pending, true));
      this.pending = Buffer.alloc(0);
      this.finished = true;
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

// -------------------------------------------------------- buffer helpers ----

async function collect(source: Readable, transform: Transform): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    }
  });

  await pipeline(source, transform, sink);

  return Buffer.concat(chunks);
}

export async function sealBuffer(
  plaintext: Buffer,
  context: StreamContext
): Promise<{ ciphertext: Buffer; stats: StreamStats }> {
  const stream = new ArtifactEncryptStream(context);
  const ciphertext = await collect(Readable.from([plaintext]), stream);

  return { ciphertext, stats: stream.stats() };
}

export async function openBuffer(
  ciphertext: Buffer,
  context: StreamContext
): Promise<{ plaintext: Buffer; stats: StreamStats }> {
  const stream = new ArtifactDecryptStream(context);
  const plaintext = await collect(Readable.from([ciphertext]), stream);

  return { plaintext, stats: stream.stats() };
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
