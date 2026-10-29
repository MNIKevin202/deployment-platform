import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleWriter, type ManifestBody } from "../migration/bundle.js";
import { MIN_CHUNK_SIZE } from "../migration/constants.js";
import type { AppFacts, PlatformFacts } from "../migration/facts.js";
import type { Manifest } from "../migration/manifest.js";
import { generateSigningKeyPair, fingerprintOf } from "../migration/signing.js";

/**
 * Shared, SYNTHETIC fixtures for migration tests. Nothing here refers to a real
 * server, real credentials, or real application data.
 */

export const TEST_PASSPHRASE = "synthetic test passphrase 001";
export const TEST_KDF = { N: 2 ** 14, r: 8, p: 1 };
export const SECRET_MARKER = "SYNTHETIC-SECRET-MARKER-9f3a1c";
export const APP_NAME = "synthetic-demo-app";
export const VOLUME_NAME = "synthetic-demo-volume";

const cleanups: string[] = [];

export function makeTempDir(prefix = "cfmig-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);

  return dir;
}

export function cleanupTempDirs(): void {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop()!, { recursive: true, force: true });
  }
}

export interface SyntheticBundle {
  directory: string;
  manifest: Manifest;
  manifestSha256: string;
  bundleId: string;
  volumeData: Buffer;
  databaseData: Buffer;
  signer: { privateKeyPem: string; fingerprint: string } | null;
}

export function sourceBody(overrides: Partial<ManifestBody> = {}): ManifestBody {
  return {
    scope: "platform",
    source: { serverId: "synthetic-source-1", platformVersion: "1.9.0", schemaVersion: 28, arch: "x64" },
    transfer: { migrationId: randomUUID(), operation: "backup", epoch: 0, previousBundleId: null },
    consistency: { mode: "rehearsal", overall: "quiesced-unverified", acceptedRisks: [] },
    apps: [],
    ...overrides
  };
}

/**
 * Builds a small but complete bundle: a database artifact, a config artifact
 * (containing a secret marker), and one app with a multi-chunk volume.
 */
export async function buildSyntheticBundle(
  options: {
    signed?: boolean;
    passphrase?: string;
    scope?: "platform" | "application";
    /** Overrides merged into the manifest body (source, transfer, consistency, …). */
    body?: Partial<ManifestBody>;
    /** Overrides for the one synthetic app's volume consistency record. */
    volumeConsistency?: Manifest["apps"][number]["volumes"][number]["consistency"];
  } = {}
): Promise<SyntheticBundle> {
  const directory = join(makeTempDir(), "bundle");
  const signer = options.signed ? generateSigningKeyPair() : null;

  const writer = await BundleWriter.create(directory, {
    passphrase: options.passphrase ?? TEST_PASSPHRASE,
    kdf: TEST_KDF,
    chunkSize: MIN_CHUNK_SIZE,
    signingKeyPem: signer?.privateKeyPem
  });

  const databaseData = Buffer.concat([Buffer.from("SQLite format 3\0"), randomBytes(5000)]);
  const volumeData = Buffer.concat([Buffer.from(`${SECRET_MARKER}-volume`), randomBytes(MIN_CHUNK_SIZE * 2 + 321)]);
  const configData = Buffer.from(`CREDENTIAL_ENCRYPTION_KEY=${SECRET_MARKER}\n`);

  const dbId = writer.allocateArtifactId();
  const configId = writer.allocateArtifactId();
  const volumeId = writer.allocateArtifactId();

  await writer.addArtifact({ id: dbId, kind: "platform-database", subject: "platform" }, databaseData);
  await writer.addArtifact({ id: configId, kind: "platform-config", subject: "platform" }, configData);
  await writer.addArtifact(
    { id: volumeId, kind: "volume", subject: "app:1", meta: { volume: VOLUME_NAME } },
    volumeData
  );

  const { manifest, manifestSha256 } = await writer.finalize(
    sourceBody({
      scope: options.scope ?? "platform",
      apps: [
        {
          ref: "app:1",
          sourceAppId: 1,
          name: APP_NAME,
          containerName: `app-${APP_NAME}`,
          image: "nginx:alpine",
          domain: `${APP_NAME}.example.test`,
          internalOnly: false,
          desiredStatus: "running",
          volumes: [
            {
              name: VOLUME_NAME,
              containerPath: "/data",
              readOnly: false,
              artifactId: volumeId,
              sizeBytes: volumeData.length,
              consistency: options.volumeConsistency ?? {
                level: "quiesced-unverified",
                strategy: "stop",
                evidence: [{ kind: "clean-exit" }]
              }
            }
          ],
          images: [],
          dependsOn: [],
          dormantOnImport: false
        }
      ],
      ...(options.body ?? {})
    })
  );

  return {
    directory,
    manifest,
    manifestSha256,
    bundleId: writer.bundleId,
    volumeData,
    databaseData,
    signer: signer
      ? {
          privateKeyPem: signer.privateKeyPem,
          fingerprint: fingerprintOf(signer.publicKeyDer)
        }
      : null
  };
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

// ------------------------------------------------------------ platform facts ----


export const PLANTED_SECRET = "Pl4nted-S3cret-Value-8c2e71";

export function makeApp(overrides: Partial<AppFacts> & { id: number; name: string }): AppFacts {
  return {
    containerName: `app-${overrides.name}`,
    image: "nginx:alpine",
    domain: `${overrides.name}.example.test`,
    internalOnly: false,
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    memoryLimitMb: null,
    cpuLimit: null,
    env: [],
    volumes: [],
    publishedPorts: [],
    cronJobs: [],
    source: null,
    deployments: [],
    healthCheck: null,
    ...overrides
  };
}

/**
 * A synthetic estate:
 *   web    (1) -> uses db via DATABASE_URL (contains a planted secret); GitHub source w/ auto-deploy; cron job
 *   db     (2)    internal-only Postgres with a data volume
 *   worker (3) -> uses web via WEB_URL
 *   static (4)    independent, stateless
 */
export function makeFacts(overrides: Partial<PlatformFacts> = {}): PlatformFacts {
  return {
    schemaVersion: 28,
    integrityCheck: "ok",
    apps: [
      makeApp({
        id: 1,
        name: "web",
        env: [
          { key: "DATABASE_URL", value: `postgres://user:${PLANTED_SECRET}@app-db:5432/main`, isSecret: true, enabled: true },
          { key: "MONGODB_URI", value: `mongodb+srv://u:${PLANTED_SECRET}@cluster.example.test/x`, isSecret: true, enabled: true }
        ],
        volumes: [{ volumeName: "web-uploads", containerPath: "/uploads", readOnly: false }],
        publishedPorts: [{ hostPort: 25565, containerPort: 25565, protocol: "udp" }],
        cronJobs: [
          { id: 1, name: "nightly-sync", cronExpression: "0 3 * * *", enabled: true, command: `curl -H "Authorization: ${PLANTED_SECRET}" https://api.example.test/sync` },
          { id: 2, name: "local-cleanup", cronExpression: "0 4 * * *", enabled: false, command: "rm -rf /tmp/cache" }
        ],
        source: {
          provider: "github",
          repositoryOwner: "example-org",
          repositoryName: "web-app",
          branch: "main",
          deploymentMode: "dockerfile",
          autoDeploy: true
        },
        deployments: [
          { version: 2, imageTag: "deployment-app-1:abc123def456", isCurrent: true, sourceKind: "github" },
          { version: 1, imageTag: "deployment-app-1:000111222333", isCurrent: false, sourceKind: "github" }
        ],
        healthCheck: { enabled: true },
        memoryLimitMb: 512,
        cpuLimit: 0.5
      }),
      makeApp({
        id: 2,
        name: "db",
        image: "postgres:16",
        domain: null,
        internalOnly: true,
        env: [{ key: "POSTGRES_PASSWORD", value: PLANTED_SECRET, isSecret: true, enabled: true }],
        volumes: [{ volumeName: "db-data", containerPath: "/var/lib/postgresql/data", readOnly: false }]
      }),
      makeApp({
        id: 3,
        name: "worker",
        env: [{ key: "WEB_URL", value: "http://app-web:3000/api", isSecret: false, enabled: true }]
      }),
      makeApp({ id: 4, name: "static" })
    ],
    globalEnv: [{ key: "TZ", value: "UTC", isSecret: false, enabled: true }],
    databaseConnections: [{ id: 1, name: "Atlas cluster", kind: "mongodb", envKey: "MONGODB_URI" }],
    credentialProviders: ["github"],
    credentialPayloads: [],
    settingKeys: [],
    activeDeploymentLockAppIds: [],
    lastUpdate: null,
    ...overrides
  };
}
