import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { BundleReader } from "../migration/bundle.js";
import { MIN_CHUNK_SIZE } from "../migration/constants.js";
import type { ExportContainerInfo } from "../migration/export-docker.js";
import { defaultRunOptions, runExport, type ExportResult, type ExportRunOptions } from "../migration/export.js";
import { DEFAULT_OPTIONS, planExport, type ExportOptions, type ExportPlan } from "../migration/export-plan.js";
import type { PlatformFacts } from "../migration/facts.js";
import { bufferEntry, FakeExportDocker, syntheticEntry, untar } from "./export-fakes.js";
import { buildSyntheticDatabase, makeKey } from "./migration-env-fixtures.js";
import { makeFacts, makeTempDir, TEST_KDF, TEST_PASSPHRASE } from "./migration-fixtures.js";

/**
 * A complete SYNTHETIC installation for export tests: a real SQLite database built
 * by the real migrations, a fake Docker daemon holding the apps' containers, volumes
 * and images, and host directories for configuration and proxy routes.
 */

export const noSleep = async (): Promise<void> => undefined;

export const PG_DUMP =
  "--\n-- PostgreSQL database cluster dump\n--\n\nCREATE ROLE app;\nCREATE TABLE t (x int);\nINSERT INTO t VALUES (1);\n\n" +
  "--\n-- PostgreSQL database cluster dump complete\n--\n";

export const WEB_INDEX = "<h1>synthetic web volume</h1>";

export interface HarnessOptions {
  facts?: PlatformFacts;
  /** Put everything under this directory (so a SEPARATE PROCESS can find it). */
  baseDir?: string;
  /** Persist the fake daemon's container states here, so another process can observe them. */
  fakeStatePath?: string;
  /** Bytes of the big synthetic file inside the web volume. */
  webBigBytes?: number;
  pgControldata?: string;
}

export interface Harness {
  facts: PlatformFacts;
  dbPath: string;
  key: Buffer;
  fake: FakeExportDocker;
  outputDir: string;
  stateDir: string;
  configDir: string;
  routesDir: string;
  logs: string[];
  plan(options?: Partial<ExportOptions>, extra?: { freeBytes?: number | null }): Promise<ExportPlan>;
  run(
    options?: Partial<ExportOptions>,
    overrides?: { run?: Partial<ExportRunOptions>; signingKeyPem?: string; plan?: ExportPlan; passphrase?: string }
  ): Promise<ExportResult>;
}

export async function makeHarness(harnessOptions: HarnessOptions = {}): Promise<Harness> {
  const facts = harnessOptions.facts ?? makeFacts();
  const base = harnessOptions.baseDir ?? makeTempDir("cfmig-export-");
  mkdirSync(join(base, "db"), { recursive: true });
  const db =buildSyntheticDatabase(facts, makeKey(), join(base, "db"));
  const outputDir = join(base, "out");
  const stateDir = join(base, "state");
  const configDir = join(base, "config");
  const routesDir = join(base, "routes");
  for (const dir of [outputDir, stateDir, configDir, join(configDir, "trusted-keys"), routesDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(configDir, "auth.env"), "CREDENTIAL_ENCRYPTION_KEY=SYNTHETIC-ENV-KEY-VALUE\nADMIN_USERNAME=admin\n");
  writeFileSync(join(configDir, "trusted-keys", "release.pem"), "-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----\n");
  writeFileSync(join(routesDir, "web.caddy"), "web.example.test { reverse_proxy app-web:3000 }\n");

  const fake = new FakeExportDocker(harnessOptions.fakeStatePath);
  for (const app of facts.apps) {
    fake.addContainer({
      name: app.containerName,
      image: app.image,
      env: app.name === "db" ? { PGDATA: "/var/lib/postgresql/data", POSTGRES_PASSWORD: "synthetic-pg-password" } : {},
      mounts: app.volumes.map((volume) => ({ type: "volume" as const, name: volume.volumeName, destination: volume.containerPath }))
    });
  }
  fake.addVolume("web-uploads", [
    bufferEntry("./index.html", Buffer.from(WEB_INDEX)),
    syntheticEntry("./big.bin", harnessOptions.webBigBytes ?? 200_000, 7)
  ]);
  fake.addVolume("db-data", [bufferEntry("./PG_VERSION", Buffer.from("16\n")), syntheticEntry("./base/1", 120_000, 9)]);
  fake.images.set("deployment-app-1:abc123def456", Buffer.alloc(150_000, 1));
  fake.images.set("deployment-app-1:000111222333", Buffer.alloc(90_000, 2));
  fake.execScripts.set("app-db", () => ({ stdout: Buffer.from(PG_DUMP), exitCode: 0 }));
  fake.helperScripts.push((options) =>
    options.entrypoint[0] === "pg_controldata"
      ? { exitCode: 0, stdout: harnessOptions.pgControldata ?? "pg_control version number:            1300\nDatabase cluster state:               shut down\n" }
      : null
  );

  const logs: string[] = [];

  const harness: Harness = {
    facts,
    dbPath: db.path,
    key: db.key,
    fake,
    outputDir,
    stateDir,
    configDir,
    routesDir,
    logs,

    async plan(options = {}, extra = {}) {
      const containers = new Map<number, ExportContainerInfo | null>();
      for (const app of facts.apps) {
        containers.set(app.id, await fake.inspectContainer(app.containerName));
      }
      const volumeSizes = new Map<string, number | null>();
      for (const [name, entries] of fake.volumes) {
        volumeSizes.set(name, entries.reduce((sum, entry) => sum + entry.size, 0));
      }
      const imageSizes = new Map([...fake.images].map(([tag, data]) => [tag, data.length] as const));

      return planExport({
        facts,
        containers,
        usage: { volumeSizes, imageSizes },
        localImageTags: new Set([...fake.images.keys(), ...facts.apps.map((app) => app.image)]),
        options: { ...DEFAULT_OPTIONS, ...options, strategies: { ...DEFAULT_OPTIONS.strategies, ...options.strategies } },
        dbSizeBytes: 100_000,
        hostPaths: { config: true, routes: true },
        outputFreeBytes: extra.freeBytes === undefined ? null : extra.freeBytes
      });
    },

    async run(options = {}, overrides = {}) {
      const plan = overrides.plan ?? (await harness.plan(options));

      return runExport({
        plan,
        facts,
        dbPath: db.path,
        outputDir,
        passphrase: overrides.passphrase ?? TEST_PASSPHRASE,
        signingKeyPem: overrides.signingKeyPem,
        client: fake,
        encryption: { available: true, key: db.key },
        hostPaths: { configDir, routesDir },
        stateDir,
        helperImage: "helper:local",
        server: { serverId: "srv-synthetic", platformVersion: "1.9.0", schemaVersion: 28, arch: "x64", dockerVersion: "27.0.0" },
        options: defaultRunOptions({
          kdf: TEST_KDF,
          chunkSize: MIN_CHUNK_SIZE,
          verify: "deep",
          log: (message) => logs.push(message),
          restore: { sleep: noSleep, verifyMs: 50, attempts: 3 },
          watchIntervalMs: 20,
          heartbeatIntervalMs: 50,
          ...overrides.run
        })
      });
    }
  };

  return harness;
}

// ------------------------------------------------------- reading a bundle ----

export interface OpenedBundle {
  reader: BundleReader;
  manifest: BundleReader["manifest"];
  /** Decrypted (and gunzipped, where the artifact says so) content of the first artifact of `kind` (and `subject`). */
  artifact(kind: string, subject?: string): Promise<Buffer>;
  artifacts(kind: string): Array<BundleReader["manifest"]["artifacts"][number]>;
  files(kind: string, subject?: string): Promise<Record<string, Buffer>>;
}

export async function openBundle(path: string, passphrase = TEST_PASSPHRASE): Promise<OpenedBundle> {
  const reader = await BundleReader.open(path, passphrase);
  const find = (kind: string, subject?: string) =>
    reader.manifest.artifacts.find((artifact) => artifact.kind === kind && (subject === undefined || artifact.subject === subject));

  const content = async (kind: string, subject?: string): Promise<Buffer> => {
    const entry = find(kind, subject);
    if (!entry) {
      throw new Error(`no ${kind} artifact${subject ? ` for ${subject}` : ""}`);
    }
    const data = await reader.readArtifactBuffer(entry.id);

    return entry.meta.compression === "gzip" ? gunzipSync(data) : data;
  };

  return {
    reader,
    manifest: reader.manifest,
    artifact: content,
    artifacts: (kind) => reader.manifest.artifacts.filter((artifact) => artifact.kind === kind),
    files: async (kind, subject) => untar(await content(kind, subject))
  };
}
