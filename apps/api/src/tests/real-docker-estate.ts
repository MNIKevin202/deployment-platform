import Docker from "dockerode";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MIN_CHUNK_SIZE } from "../migration/constants.js";
import type { ExportContainerInfo } from "../migration/export-docker.js";
import { createExportDockerClient, type ExportDockerClient } from "../migration/export-docker.js";
import { defaultRunOptions, runExport, type ExportResult, type ExportRunOptions } from "../migration/export.js";
import { DEFAULT_OPTIONS, planExport, type ExportOptions, type ExportPlan } from "../migration/export-plan.js";
import type { PlatformFacts } from "../migration/facts.js";
import { readPlatformFacts } from "../migration/inventory.js";
import { createDockerProbe, readOnlyClientFrom } from "../migration/probes.js";
import { buildSyntheticDatabase, makeKey } from "./migration-env-fixtures.js";
import { makeApp, makeFacts, TEST_KDF, TEST_PASSPHRASE } from "./migration-fixtures.js";

/**
 * Helpers for the REAL-Docker integration tests. Everything they create carries the
 * label `cfmig-itest=<runId>` and a `cfmig-itest-<runId>-` name prefix, and cleanup
 * removes ONLY resources carrying that label. They never touch anything else on the
 * daemon. They use only images already present locally and never pull.
 */

export const ITEST_LABEL = "cfmig-itest";
export const PG_IMAGE = "postgres:16-alpine";
export const DEBIAN_IMAGE = "debian:bookworm-slim";

export const dockerSocket = (): string =>
  process.env.DOCKER_SOCKET ?? (process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock");

export function newDocker(): Docker {
  return new Docker({ socketPath: dockerSocket() });
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    const docker = newDocker();
    await docker.ping();
    for (const image of [PG_IMAGE, DEBIAN_IMAGE]) {
      await docker.getImage(image).inspect();
    }

    return true;
  } catch {
    return false;
  }
}

export const names = (runId: string) => ({
  pgContainer: `cfmig-itest-${runId}-db`,
  pgVolume: `cfmig-itest-${runId}-pgdata`,
  webContainer: `cfmig-itest-${runId}-web`,
  webVolume: `cfmig-itest-${runId}-webdata`
});

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function execOut(client: ExportDockerClient, container: string, cmd: string[]): Promise<{ code: number; out: string }> {
  const exec = await client.exec(container, cmd);
  const chunks: Buffer[] = [];
  for await (const chunk of exec.stdout) {
    chunks.push(chunk as Buffer);
  }
  const finished = await exec.finished();

  return { code: finished.exitCode, out: Buffer.concat(chunks).toString() };
}

/** Creates a labelled volume and fills it using a throwaway container. */
async function makeVolume(docker: Docker, runId: string, name: string, script: string): Promise<void> {
  await docker.createVolume({ Name: name, Labels: { [ITEST_LABEL]: runId } });
  const filler = await docker.createContainer({
    Image: DEBIAN_IMAGE,
    Cmd: ["sh", "-c", script],
    Labels: { [ITEST_LABEL]: runId },
    HostConfig: { Binds: [`${name}:/v`] }
  });
  await filler.start();
  await filler.wait();
  await filler.remove({ force: true });
}

export interface EstateOptions {
  /** MiB of incompressible data in the web volume. */
  webMegabytes?: number;
  /** If true the web process ignores SIGTERM, so `docker stop` must SIGKILL it. */
  webIgnoresTerm?: boolean;
}

/** A real PostgreSQL app and a plain debian "web" app, each with a real volume. */
export async function createEstate(runId: string, options: EstateOptions = {}): Promise<void> {
  const docker = newDocker();
  const n = names(runId);
  const labels = { [ITEST_LABEL]: runId };

  await makeVolume(docker, runId, n.webVolume, `echo CFMIG-WEB-FILE > /v/hello.txt; head -c ${(options.webMegabytes ?? 1) * 1024 * 1024} /dev/urandom > /v/big.bin`);
  await docker.createVolume({ Name: n.pgVolume, Labels: labels });

  const pg = await docker.createContainer({
    name: n.pgContainer,
    Image: PG_IMAGE,
    Env: ["POSTGRES_PASSWORD=itest-password", "POSTGRES_USER=postgres"],
    Labels: labels,
    HostConfig: { Binds: [`${n.pgVolume}:/var/lib/postgresql/data`] }
  });
  await pg.start();

  const web = await docker.createContainer({
    name: n.webContainer,
    Image: DEBIAN_IMAGE,
    Cmd: ["sh", "-c", options.webIgnoresTerm ? 'trap "" TERM; while true; do sleep 1; done' : "sleep 100000"],
    Labels: labels,
    StopTimeout: 1,
    HostConfig: { Binds: [`${n.webVolume}:/data`] }
  });
  await web.start();
}

export async function waitForPostgres(client: ExportDockerClient, runId: string): Promise<void> {
  const db = names(runId).pgContainer;
  // TCP, not the unix socket: the init-phase temporary server listens on the socket only.
  await waitFor(async () => (await execOut(client, db, ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"])).code === 0, "PostgreSQL to accept TCP connections");
  await sleep(1500);
  await waitFor(async () => (await execOut(client, db, ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"])).code === 0, "PostgreSQL to stay up");
}

export const MARKER = "CFMIG-REAL-ROW-7f3a";

export async function seedPostgres(client: ExportDockerClient, runId: string): Promise<void> {
  const db = names(runId).pgContainer;
  const result = await execOut(client, db, ["psql", "-U", "postgres", "-c", `create table itest(x text); insert into itest values ('${MARKER}')`]);
  if (result.code !== 0) {
    throw new Error(`could not seed postgres: ${result.out}`);
  }
}

/**
 * Export helper containers that belong to THIS run: those whose binds mention this run's
 * volumes. (They carry the exporter's own label, not ours, so they are found by what they mount.)
 */
export async function ourHelperIds(runId: string): Promise<string[]> {
  const docker = newDocker();
  const found: string[] = [];
  const helpers = await docker.listContainers({ all: true, filters: { label: ["com.deployment-platform.migration-tool=export-helper"] } });

  for (const helper of helpers) {
    const detail = await docker.getContainer(helper.Id).inspect().catch(() => null);
    if ((detail?.HostConfig.Binds ?? []).some((bind: string) => bind.startsWith(`cfmig-itest-${runId}-`))) {
      found.push(helper.Id);
    }
  }

  return found;
}

export async function cleanupEstate(runId: string): Promise<void> {
  const docker = newDocker();
  for (const id of await ourHelperIds(runId)) {
    await docker.getContainer(id).remove({ force: true, v: false }).catch(() => undefined);
  }
  const filters = { label: [`${ITEST_LABEL}=${runId}`] };
  for (const info of await docker.listContainers({ all: true, filters })) {
    await docker.getContainer(info.Id).remove({ force: true, v: false }).catch(() => undefined);
  }
  for (const volume of (await docker.listVolumes({ filters })).Volumes ?? []) {
    await docker.getVolume(volume.Name).remove({ force: true }).catch(() => undefined);
  }
}

/** Everything on the daemon carrying our label, for before/after comparisons. */
export async function snapshotOurs(runId: string): Promise<string[]> {
  const docker = newDocker();
  const filters = { label: [`${ITEST_LABEL}=${runId}`] };
  const containers = (await docker.listContainers({ all: true, filters })).map((c) => `c:${c.Names[0]}:${c.State}`);
  const volumes = ((await docker.listVolumes({ filters })).Volumes ?? []).map((v) => `v:${v.Name}`);

  return [...containers, ...volumes].sort();
}

/** Helper containers of this run that still exist. */
export async function leftoverHelpers(runId: string): Promise<number> {
  return (await ourHelperIds(runId)).length;
}

// --------------------------------------------------------- export wiring ----

export interface RealEstateHarness {
  facts: PlatformFacts;
  dbPath: string;
  outputDir: string;
  stateDir: string;
  client: ExportDockerClient;
  logs: string[];
  plan(options: Partial<ExportOptions>): Promise<ExportPlan>;
  run(options: Partial<ExportOptions>, run?: Partial<ExportRunOptions>): Promise<ExportResult>;
}

export function realFacts(runId: string): PlatformFacts {
  const n = names(runId);

  return makeFacts({
    apps: [
      makeApp({
        id: 1,
        name: "db",
        containerName: n.pgContainer,
        image: PG_IMAGE,
        domain: null,
        internalOnly: true,
        env: [{ key: "POSTGRES_PASSWORD", value: "itest-password", isSecret: true, enabled: true }],
        volumes: [{ volumeName: n.pgVolume, containerPath: "/var/lib/postgresql/data", readOnly: false }]
      }),
      makeApp({
        id: 2,
        name: "web",
        containerName: n.webContainer,
        image: DEBIAN_IMAGE,
        volumes: [{ volumeName: n.webVolume, containerPath: "/data", readOnly: false }]
      })
    ],
    globalEnv: [],
    databaseConnections: [],
    credentialProviders: []
  });
}

export function makeRealHarness(runId: string, baseDir: string): RealEstateHarness {
  const docker = newDocker();
  const client = createExportDockerClient(docker);
  const probe = createDockerProbe(readOnlyClientFrom(docker));
  const facts = realFacts(runId);
  mkdirSync(join(baseDir, "db"), { recursive: true });
  const db = buildSyntheticDatabase(facts, makeKey(), join(baseDir, "db"));
  const outputDir = join(baseDir, "out");
  const stateDir = join(baseDir, "state");
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const logs: string[] = [];

  const harness: RealEstateHarness = {
    facts: readPlatformFacts(db.path),
    dbPath: db.path,
    outputDir,
    stateDir,
    client,
    logs,

    async plan(options) {
      const containers = new Map<number, ExportContainerInfo | null>();
      for (const app of facts.apps) {
        containers.set(app.id, await client.inspectContainer(app.containerName));
      }
      const usage = await probe.diskUsage();
      const localImageTags = new Set((await probe.listImages()).flatMap((image) => image.tags));

      return planExport({
        facts: harness.facts,
        containers,
        usage,
        localImageTags,
        options: { ...DEFAULT_OPTIONS, ...options, strategies: { ...DEFAULT_OPTIONS.strategies, ...options.strategies } },
        dbSizeBytes: 100_000,
        hostPaths: { config: false, routes: false },
        outputFreeBytes: null
      });
    },

    async run(options, run = {}) {
      const plan = await harness.plan(options);

      return runExport({
        plan,
        facts: harness.facts,
        dbPath: db.path,
        outputDir,
        passphrase: TEST_PASSPHRASE,
        client,
        encryption: { available: true, key: db.key },
        hostPaths: { configDir: null, routesDir: null },
        stateDir,
        helperImage: DEBIAN_IMAGE,
        server: { serverId: "srv-itest", platformVersion: "1.9.0", schemaVersion: 28, arch: "x64", dockerVersion: "real" },
        options: defaultRunOptions({
          kdf: TEST_KDF,
          chunkSize: MIN_CHUNK_SIZE,
          verify: "deep",
          log: (message) => void logs.push(message),
          watchIntervalMs: 100,
          heartbeatIntervalMs: 500,
          restore: { verifyMs: 30_000, attempts: 3 },
          ...run
        })
      });
    }
  };

  return harness;
}
