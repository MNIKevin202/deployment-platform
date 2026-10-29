import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ARTIFACT_DIR,
  ARTIFACT_EXTENSION,
  ARTIFACT_ID_PATTERN,
  HEADER_FILE,
  MANIFEST_ARTIFACT_ID,
  MANIFEST_FILE,
  MAX_HEADER_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_SIGNATURE_BYTES,
  MANIFEST_SCHEMA_VERSION,
  SIGNATURE_FILE
} from "./constants.js";
import {
  ArtifactDecryptStream,
  ArtifactEncryptStream,
  createBundleHeader,
  IntegrityError,
  openBuffer,
  parseBundleHeader,
  sealBuffer,
  sha256Hex,
  UnsupportedBundleError,
  unwrapBundleKey,
  WrongPassphraseError,
  type BundleHeader,
  type KdfCost,
  type StreamContext,
  type StreamStats
} from "./crypto.js";
import {
  parseManifest,
  serializeManifest,
  type Manifest,
  type ManifestArtifact
} from "./manifest.js";
import {
  normalizeFingerprint,
  signatureFileSchema,
  signManifest,
  verifyManifestSignature,
  type SignatureFile
} from "./signing.js";

/**
 * Reading and writing bundle directories, and verifying them. Verification
 * reports INTEGRITY and AUTHENTICITY as two separate outcomes — see
 * docs/MIGRATION_BUNDLE_FORMAT.md §1.
 */

// ----------------------------------------------------------------- writer ----

export interface CreateBundleOptions {
  passphrase: string;
  chunkSize?: number;
  /** Tests inject a cheaper KDF; production uses the default. */
  kdf?: KdfCost;
  bundleId?: string;
  /** PKCS#8 PEM. When present the manifest is signed. */
  signingKeyPem?: string;
}

export type ManifestBody = Omit<Manifest, "artifacts" | "bundleId" | "manifestSchemaVersion" | "createdAt"> & {
  createdAt?: string;
};

export interface AddArtifactSpec {
  /** Opaque id (becomes the file name). Use `allocateArtifactId()` if unsure. */
  id: string;
  kind: ManifestArtifact["kind"];
  subject: ManifestArtifact["subject"];
  meta?: ManifestArtifact["meta"];
}

export class BundleWriter {
  readonly header: BundleHeader;
  private readonly bundleKey: Buffer;
  private readonly artifacts: ManifestArtifact[] = [];
  private nextSequence = 1;
  private finalized = false;

  private constructor(
    readonly directory: string,
    header: BundleHeader,
    bundleKey: Buffer,
    private readonly signingKeyPem: string | undefined
  ) {
    this.header = header;
    this.bundleKey = bundleKey;
  }

  /** Creates the directory and writes the (authenticated) header. Refuses a non-empty directory. */
  static async create(directory: string, options: CreateBundleOptions): Promise<BundleWriter> {
    // Validate and derive everything BEFORE creating anything: a bad passphrase must leave no directory behind.
    const { header, bundleKey } = await createBundleHeader({
      passphrase: options.passphrase,
      chunkSize: options.chunkSize,
      kdf: options.kdf,
      bundleId: options.bundleId
    });

    await mkdir(directory, { recursive: true });
    if ((await readdir(directory)).length > 0) {
      throw new Error(`Refusing to write a bundle into a non-empty directory: ${directory}`);
    }

    await mkdir(join(directory, ARTIFACT_DIR));
    await writeFile(join(directory, HEADER_FILE), `${JSON.stringify(header, null, 2)}\n`, {
      flag: "wx"
    });

    return new BundleWriter(directory, header, bundleKey, options.signingKeyPem);
  }

  get bundleId(): string {
    return this.header.bundleId;
  }

  /** Opaque, sequential artifact ids ("a0001"…): names reveal nothing about content. */
  allocateArtifactId(): string {
    const id = `a${String(this.nextSequence).padStart(4, "0")}`;
    this.nextSequence += 1;

    return id;
  }

  private context(artifactId: string): StreamContext {
    return {
      bundleKey: this.bundleKey,
      bundleId: this.header.bundleId,
      artifactId,
      chunkSize: this.header.chunkSize
    };
  }

  /** Encrypts and stores one artifact atomically (write to .partial, then rename). */
  async addArtifact(spec: AddArtifactSpec, source: Readable | Buffer): Promise<ManifestArtifact> {
    if (this.finalized) {
      throw new Error("The bundle has already been finalized.");
    }
    if (!ARTIFACT_ID_PATTERN.test(spec.id) || spec.id === MANIFEST_ARTIFACT_ID) {
      throw new Error(`Invalid artifact id "${spec.id}".`);
    }
    if (this.artifacts.some((artifact) => artifact.id === spec.id)) {
      throw new Error(`Duplicate artifact id "${spec.id}".`);
    }

    const finalPath = join(this.directory, ARTIFACT_DIR, `${spec.id}${ARTIFACT_EXTENSION}`);
    const partialPath = `${finalPath}.partial`;
    const encrypt = new ArtifactEncryptStream(this.context(spec.id));
    const input = Buffer.isBuffer(source) ? Readable.from([source]) : source;

    try {
      await pipeline(input, encrypt, createWriteStream(partialPath, { flags: "wx" }));
      await rename(partialPath, finalPath);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }

    const stats = encrypt.stats();
    const entry: ManifestArtifact = {
      id: spec.id,
      kind: spec.kind,
      subject: spec.subject,
      plaintextBytes: stats.plaintextBytes,
      plaintextSha256: stats.plaintextSha256,
      ciphertextBytes: stats.ciphertextBytes,
      ciphertextSha256: stats.ciphertextSha256,
      meta: spec.meta ?? {}
    };
    this.artifacts.push(entry);

    return entry;
  }

  /** Writes the encrypted manifest (and signature). The bundle is complete only after this. */
  async finalize(body: ManifestBody): Promise<{ manifest: Manifest; manifestSha256: string }> {
    if (this.finalized) {
      throw new Error("The bundle has already been finalized.");
    }

    const manifest = parseManifest({
      ...body,
      manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
      bundleId: this.header.bundleId,
      createdAt: body.createdAt ?? new Date().toISOString(),
      artifacts: this.artifacts
    });

    const plaintext = serializeManifest(manifest);
    const manifestSha256 = sha256Hex(plaintext);
    const sealed = await sealBuffer(plaintext, this.context(MANIFEST_ARTIFACT_ID));

    await writeFile(join(this.directory, MANIFEST_FILE), sealed.ciphertext, { flag: "wx" });

    if (this.signingKeyPem) {
      const signature = signManifest({
        privateKeyPem: this.signingKeyPem,
        bundleId: this.header.bundleId,
        manifestSha256
      });
      await writeFile(join(this.directory, SIGNATURE_FILE), `${JSON.stringify(signature, null, 2)}\n`, {
        flag: "wx"
      });
    }

    this.finalized = true;

    return { manifest, manifestSha256 };
  }
}

// ----------------------------------------------------------------- reader ----

/**
 * Reads an UNTRUSTED file from a bundle: it must be a plain file (never a symlink that
 * could point somewhere else on this machine) and within `limit` bytes, checked BEFORE
 * anything is read into memory. A missing file surfaces as the original ENOENT.
 */
async function readBoundedFile(path: string, limit: number, code: "HEADER_INVALID" | "MANIFEST_CORRUPT"): Promise<Buffer> {
  const info = await lstat(path);

  if (!info.isFile()) {
    throw new BundleFormatError(code, "A bundle file is not a regular file (symbolic links are not followed).");
  }
  if (info.size > limit) {
    throw new BundleFormatError(code, "A bundle file is larger than the format allows.");
  }

  return readFile(path);
}

async function assertRegularFile(path: string): Promise<void> {
  if (!(await lstat(path)).isFile()) {
    throw new IntegrityError("MANIFEST_MISMATCH", "An artifact is not a regular file (symbolic links are not followed).");
  }
}

export class BundleReader {
  private constructor(
    readonly directory: string,
    readonly header: BundleHeader,
    readonly manifest: Manifest,
    readonly manifestSha256: string,
    readonly signature: SignatureFile | null,
    readonly signatureProblem: string | null,
    private readonly bundleKey: Buffer
  ) {}

  /**
   * Opens a bundle: parses the header, unwraps the key, decrypts and validates the
   * manifest. Throws WrongPassphraseError / IntegrityError / UnsupportedBundleError /
   * ZodError on failure — use `verifyBundle` for a structured result.
   */
  static async open(directory: string, passphrase: string): Promise<BundleReader> {
    const headerText = (
      await readBoundedFile(join(directory, HEADER_FILE), MAX_HEADER_BYTES, "HEADER_INVALID").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            throw new BundleFormatError(
              "HEADER_INVALID",
              `This does not look like a migration bundle (${HEADER_FILE} not found).`
            );
          }
          throw error;
        }
      )
    ).toString("utf8");

    let header: BundleHeader;
    try {
      header = parseBundleHeader(JSON.parse(headerText));
    } catch (error) {
      if (error instanceof UnsupportedBundleError) {
        throw error;
      }
      throw new BundleFormatError("HEADER_INVALID", "The bundle header is malformed or unsupported.");
    }

    const { bundleKey } = await unwrapBundleKey(header, passphrase);

    const sealedManifest = await readBoundedFile(join(directory, MANIFEST_FILE), MAX_MANIFEST_BYTES, "MANIFEST_CORRUPT").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          throw new BundleIncompleteError("manifest.enc is missing: the export did not finish.");
        }
        throw error;
      }
    );

    const { plaintext } = await openBuffer(sealedManifest, {
      bundleKey,
      bundleId: header.bundleId,
      artifactId: MANIFEST_ARTIFACT_ID,
      chunkSize: header.chunkSize
    });

    let manifest: Manifest;
    try {
      manifest = parseManifest(JSON.parse(plaintext.toString("utf8")));
    } catch {
      throw new BundleFormatError("MANIFEST_CORRUPT", "The manifest is malformed or unsupported.");
    }

    if (manifest.bundleId !== header.bundleId) {
      throw new IntegrityError(
        "MANIFEST_MISMATCH",
        "The manifest belongs to a different bundle than the header."
      );
    }

    let signature: SignatureFile | null = null;
    let signatureProblem: string | null = null;
    try {
      signature = signatureFileSchema.parse(
        JSON.parse((await readBoundedFile(join(directory, SIGNATURE_FILE), MAX_SIGNATURE_BYTES, "MANIFEST_CORRUPT")).toString("utf8"))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        signatureProblem = "The signature file exists but is malformed.";
      }
    }

    return new BundleReader(
      directory,
      header,
      manifest,
      sha256Hex(plaintext),
      signature,
      signatureProblem,
      bundleKey
    );
  }

  private context(artifactId: string): StreamContext {
    return {
      bundleKey: this.bundleKey,
      bundleId: this.header.bundleId,
      artifactId,
      chunkSize: this.header.chunkSize
    };
  }

  artifactPath(artifactId: string): string {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      throw new Error(`Invalid artifact id "${artifactId}".`);
    }

    return join(this.directory, ARTIFACT_DIR, `${artifactId}${ARTIFACT_EXTENSION}`);
  }

  /**
   * Streams one artifact's authenticated plaintext into `destination`, then
   * checks it against the manifest. The destination has ALREADY received data
   * by the time a late failure is detected, so callers must write to a
   * temporary location and promote it only if this resolves.
   */
  async readArtifact(artifactId: string, destination: Writable): Promise<StreamStats> {
    const entry = this.manifest.artifacts.find((artifact) => artifact.id === artifactId);
    if (!entry) {
      throw new Error(`Artifact "${artifactId}" is not in the manifest.`);
    }

    const decrypt = new ArtifactDecryptStream(this.context(artifactId));
    await assertRegularFile(this.artifactPath(artifactId));
    await pipeline(createReadStream(this.artifactPath(artifactId)), decrypt, destination);
    const stats = decrypt.stats();

    if (
      stats.plaintextSha256 !== entry.plaintextSha256 ||
      stats.plaintextBytes !== entry.plaintextBytes ||
      stats.ciphertextSha256 !== entry.ciphertextSha256 ||
      stats.ciphertextBytes !== entry.ciphertextBytes
    ) {
      throw new IntegrityError(
        "MANIFEST_MISMATCH",
        `Artifact "${artifactId}" does not match the hashes recorded in the manifest.`
      );
    }

    return stats;
  }

  async readArtifactBuffer(artifactId: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await this.readArtifact(
      artifactId,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        }
      })
    );

    return Buffer.concat(chunks);
  }
}

export class BundleFormatError extends Error {
  constructor(
    readonly code: "HEADER_INVALID" | "MANIFEST_CORRUPT",
    message: string
  ) {
    super(message);
    this.name = "BundleFormatError";
  }
}

export class BundleIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleIncompleteError";
  }
}

// ----------------------------------------------------------- verification ----

export type ProblemCode =
  | "HEADER_INVALID"
  | "UNSUPPORTED_FORMAT"
  | "WRONG_PASSPHRASE"
  | "MANIFEST_CORRUPT"
  | "INCOMPLETE_EXPORT"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_SIZE_MISMATCH"
  | "ARTIFACT_UNLISTED"
  | "ARTIFACT_PARTIAL"
  | "ARTIFACT_AUTHENTICATION_FAILED"
  | "ARTIFACT_HASH_MISMATCH";

export interface IntegrityProblem {
  code: ProblemCode;
  artifactId?: string;
  message: string;
}

export interface IntegrityResult {
  status: "verified" | "failed";
  depth: "structure" | "deep";
  artifactsChecked: number;
  problems: IntegrityProblem[];
}

export interface AuthenticityResult {
  /**
   * - origin-verified: valid signature by the pinned signer.
   * - passphrase-only: the creator knew the passphrase; ORIGIN is not established.
   * - failed: a signature policy was violated or a signature was invalid.
   * - not-checked: verification could not get far enough to evaluate it.
   */
  status: "origin-verified" | "passphrase-only" | "failed" | "not-checked";
  signerFingerprint: string | null;
  pinned: boolean;
  notes: string[];
}

export interface BundleVerification {
  integrity: IntegrityResult;
  authenticity: AuthenticityResult;
  manifest: Manifest | null;
}

export interface VerifyOptions {
  /** Read and authenticate every byte of every artifact. */
  deep?: boolean;
  /** Pin the expected signer fingerprint (obtained out of band). Implies a signature is required. */
  expectedSignerFingerprint?: string;
  /** Fail if no signature is present, even without a pinned fingerprint. */
  requireSignature?: boolean;
}

const NOT_CHECKED: AuthenticityResult = {
  status: "not-checked",
  signerFingerprint: null,
  pinned: false,
  notes: ["Authenticity could not be evaluated because the bundle could not be opened."]
};

/**
 * Verifies a bundle and returns a structured, never-throwing result. Read-only:
 * nothing is extracted to disk.
 */
export async function verifyBundle(
  directory: string,
  passphrase: string,
  options: VerifyOptions = {}
): Promise<BundleVerification> {
  const depth: IntegrityResult["depth"] = options.deep ? "deep" : "structure";
  const failed = (problem: IntegrityProblem): BundleVerification => ({
    integrity: { status: "failed", depth, artifactsChecked: 0, problems: [problem] },
    authenticity: NOT_CHECKED,
    manifest: null
  });

  let reader: BundleReader;
  try {
    reader = await BundleReader.open(directory, passphrase);
  } catch (error) {
    if (error instanceof WrongPassphraseError) {
      return failed({ code: "WRONG_PASSPHRASE", message: error.message });
    }
    if (error instanceof UnsupportedBundleError) {
      return failed({ code: "UNSUPPORTED_FORMAT", message: error.message });
    }
    if (error instanceof BundleIncompleteError) {
      return failed({ code: "INCOMPLETE_EXPORT", message: error.message });
    }
    if (error instanceof IntegrityError) {
      return failed({
        code: "MANIFEST_CORRUPT",
        message: `The manifest failed verification: ${error.message}`
      });
    }
    if (error instanceof BundleFormatError) {
      return failed({ code: error.code, message: error.message });
    }

    throw error;
  }

  const problems: IntegrityProblem[] = [];
  const listed = new Map(reader.manifest.artifacts.map((artifact) => [artifact.id, artifact]));

  // Structure: every listed artifact exists at the recorded size.
  for (const artifact of reader.manifest.artifacts) {
    try {
      const info = await lstat(reader.artifactPath(artifact.id));
      if (!info.isFile()) {
        problems.push({
          code: "ARTIFACT_MISSING",
          artifactId: artifact.id,
          message: `Artifact ${artifact.id} is not a regular file (symbolic links are not followed).`
        });
      } else if (info.size !== artifact.ciphertextBytes) {
        problems.push({
          code: "ARTIFACT_SIZE_MISMATCH",
          artifactId: artifact.id,
          message: `Artifact ${artifact.id} is ${info.size} bytes; the manifest records ${artifact.ciphertextBytes}.`
        });
      }
    } catch {
      problems.push({
        code: "ARTIFACT_MISSING",
        artifactId: artifact.id,
        message: `Artifact ${artifact.id} is listed in the manifest but missing.`
      });
    }
  }

  // Structure: nothing unlisted or half-written lingers in the artifact directory.
  for (const name of await readdir(join(directory, ARTIFACT_DIR)).catch(() => [] as string[])) {
    if (name.endsWith(".partial")) {
      problems.push({
        code: "ARTIFACT_PARTIAL",
        message: `${name} is an unfinished write: the export did not complete cleanly.`
      });
    } else if (!name.endsWith(ARTIFACT_EXTENSION) || !listed.has(name.slice(0, -ARTIFACT_EXTENSION.length))) {
      problems.push({
        code: "ARTIFACT_UNLISTED",
        message: `${name} is present in the bundle but not listed in the manifest.`
      });
    }
  }

  // Deep: authenticate every chunk of every artifact and compare to the manifest.
  let checked = 0;
  if (options.deep) {
    const sink = (): Writable =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        }
      });

    for (const artifact of reader.manifest.artifacts) {
      if (problems.some((problem) => problem.artifactId === artifact.id)) {
        continue;
      }

      try {
        await reader.readArtifact(artifact.id, sink());
        checked += 1;
      } catch (error) {
        problems.push(
          error instanceof IntegrityError && error.code === "MANIFEST_MISMATCH"
            ? {
                code: "ARTIFACT_HASH_MISMATCH",
                artifactId: artifact.id,
                message: `Artifact ${artifact.id} decrypts but does not match the manifest hashes.`
              }
            : {
                code: "ARTIFACT_AUTHENTICATION_FAILED",
                artifactId: artifact.id,
                message: `Artifact ${artifact.id} failed authentication: ${(error as Error).message}`
              }
        );
      }
    }
  } else {
    const flagged = new Set(problems.map((problem) => problem.artifactId).filter(Boolean));
    checked = reader.manifest.artifacts.length - flagged.size;
  }

  return {
    integrity: {
      status: problems.length === 0 ? "verified" : "failed",
      depth,
      artifactsChecked: Math.max(checked, 0),
      problems
    },
    authenticity: evaluateAuthenticity(reader, options),
    manifest: reader.manifest
  };
}

function evaluateAuthenticity(reader: BundleReader, options: VerifyOptions): AuthenticityResult {
  const pin = options.expectedSignerFingerprint
    ? normalizeFingerprint(options.expectedSignerFingerprint)
    : null;
  const mustBeSigned = pin !== null || options.requireSignature === true;

  if (reader.signatureProblem) {
    return {
      status: "failed",
      signerFingerprint: null,
      pinned: pin !== null,
      notes: [reader.signatureProblem]
    };
  }

  if (!reader.signature) {
    return mustBeSigned
      ? {
          status: "failed",
          signerFingerprint: null,
          pinned: pin !== null,
          notes: [
            "No signature is present, but a signed bundle was required. A missing signature is " +
              "treated as a failure: it may have been stripped."
          ]
        }
      : {
          status: "passphrase-only",
          signerFingerprint: null,
          pinned: false,
          notes: [
            "Unsigned. Integrity is verified, but the only authenticity established is that the " +
              "creator knew the passphrase. The origin of this bundle is NOT established."
          ]
        };
  }

  const check = verifyManifestSignature(reader.signature, reader.header.bundleId, reader.manifestSha256);

  if (!check.valid) {
    return {
      status: "failed",
      signerFingerprint: reader.signature.fingerprint,
      pinned: pin !== null,
      notes: [`Invalid signature: ${check.reason}`]
    };
  }

  if (pin === null) {
    return {
      status: "passphrase-only",
      signerFingerprint: check.fingerprint,
      pinned: false,
      notes: [
        `Signed by ${check.fingerprint}, but no expected signer was pinned. An attacker can sign a ` +
          "forged bundle with their own key, so this does NOT establish origin. Compare this " +
          "fingerprint with the one shown on the source server, or re-run with --expect-signer."
      ]
    };
  }

  return check.fingerprint === pin
    ? {
        status: "origin-verified",
        signerFingerprint: check.fingerprint,
        pinned: true,
        notes: ["The manifest signature is valid and matches the pinned signer."]
      }
    : {
        status: "failed",
        signerFingerprint: check.fingerprint,
        pinned: true,
        notes: [
          `The bundle is signed by ${check.fingerprint}, which is NOT the pinned signer ${pin}.`
        ]
      };
}
