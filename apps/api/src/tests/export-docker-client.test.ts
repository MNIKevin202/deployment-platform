import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Docker from "dockerode";
import { createExportDockerClient, HELPER_LABEL_VALUE, LABEL_MIGRATION_TOOL, type ExportDockerClient } from "../migration/export-docker.js";
import { tarOf, untar, lazyTar, syntheticEntry } from "./export-fakes.js";
import { FakeDockerEngine, frame } from "./fake-docker-engine.js";

/**
 * The REAL dockerode-based export client, exercised over HTTP against a fake Docker
 * engine. This is the closest to a real daemon that is possible without one: the
 * wire protocol (including the exec upgrade handshake and multiplexed frames) is real.
 */

const engine = new FakeDockerEngine();
let client: ExportDockerClient;

before(async () => {
  await engine.start();
  client = createExportDockerClient(new Docker({ host: "127.0.0.1", port: engine.port }));
});
after(async () => {
  await engine.stop();
});
beforeEach(() => {
  engine.requests.length = 0;
  engine.containers.clear();
  engine.volumes.clear();
  engine.images.clear();
  engine.archives.clear();
  engine.execs.clear();
  engine.overrides.clear();
  engine.created = [];
  engine.resetIds();
  engine.containers.set("app-db", { id: "id-db", name: "app-db", running: true, image: "postgres:16", env: ["PGDATA=/var/lib/postgresql/data", "POSTGRES_PASSWORD=pw"], mounts: [{ Type: "volume", Name: "db-data", Destination: "/var/lib/postgresql/data", RW: true }] });
});

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

describe("container lifecycle over the wire", () => {
  test("inspect parses state, mounts and environment; a missing container is null, not an error", async () => {
    const info = await client.inspectContainer("app-db");

    assert.equal(info?.running, true);
    assert.equal(info?.image, "postgres:16");
    assert.equal(info?.env.PGDATA, "/var/lib/postgresql/data");
    assert.deepEqual(info?.mounts.map((m) => [m.type, m.name, m.destination]), [["volume", "db-data", "/var/lib/postgresql/data"]]);
    assert.equal(await client.inspectContainer("nope"), null);
  });

  test("stop and start send the right requests; Docker's 304 ('already done') is success", async () => {
    await client.stopContainer("app-db", 17);
    assert.equal(engine.containers.get("app-db")!.running, false);
    assert.equal(engine.calls(/POST \/containers\/app-db\/stop/)[0]!.query.get("t"), "17");

    await client.stopContainer("app-db", 17); // already stopped -> 304
    await client.startContainer("app-db");
    await client.startContainer("app-db"); // already running -> 304
    assert.equal(engine.containers.get("app-db")!.running, true);
  });

  test("a real failure (not 304) is an error", async () => {
    engine.overrides.set("POST /containers/app-db/stop", 500);
    await assert.rejects(client.stopContainer("app-db", 5), /injected 500/);

    engine.overrides.set("POST /containers/ghost/stop", 404);
    await assert.rejects(client.stopContainer("ghost", 5));
  });

  test("pause and unpause", async () => {
    await client.pauseContainer("app-db");
    assert.equal(engine.containers.get("app-db")!.paused, true);
    await client.unpauseContainer("app-db");
    assert.equal(engine.containers.get("app-db")!.paused, false);
  });
});

describe("exec: the upgrade handshake, multiplexed frames, and exit codes", () => {
  test("stdout is demultiplexed from stderr and the exit code is read afterwards", async () => {
    engine.execs.set("app-db", { frames: [frame(1, "-- dump line 1\n"), frame(2, "warning: x\n"), frame(1, "-- complete\n")], exitCode: 0 });
    const exec = await client.exec("app-db", ["pg_dumpall", "-U", "postgres"], { user: "postgres" });

    assert.equal((await collect(exec.stdout)).toString(), "-- dump line 1\n-- complete\n");
    assert.deepEqual(await exec.finished(), { exitCode: 0, stderr: "warning: x\n" });

    const create = engine.calls(/POST \/containers\/app-db\/exec/)[0]!.body as Record<string, unknown>;
    assert.deepEqual(create.Cmd, ["pg_dumpall", "-U", "postgres"]);
    assert.equal(create.AttachStdout, true);
    assert.equal(create.Tty, false);
    assert.equal(create.User, "postgres");
    assert.ok(engine.requests.some((r) => (r.body as { upgrade?: boolean })?.upgrade), "the hijacked exec start used the upgrade handshake");
  });

  test("a non-zero exit code is reported", async () => {
    engine.execs.set("app-db", { frames: [frame(2, "pg_dumpall: error: connection refused\n")], exitCode: 1 });
    const exec = await client.exec("app-db", ["pg_dumpall"]);
    await collect(exec.stdout);

    assert.deepEqual(await exec.finished(), { exitCode: 1, stderr: "pg_dumpall: error: connection refused\n" });
  });

  test("a large dump streams through a slow consumer without piling up in memory", async () => {
    const payload = Buffer.alloc(32 * 1024, 7);
    const frames = Array.from({ length: 400 }, () => frame(1, payload)); // ~12.5 MB
    engine.execs.set("app-db", { frames, exitCode: 0 });
    const exec = await client.exec("app-db", ["dump"]);

    let received = 0;
    let peakBuffered = 0;
    await pipeline(
      exec.stdout,
      new Writable({
        highWaterMark: 16 * 1024,
        write(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          peakBuffered = Math.max(peakBuffered, (exec.stdout as PassThrough).readableLength);
          setImmediate(cb);
        }
      })
    );

    assert.equal(received, 400 * payload.length);
    assert.ok(peakBuffered <= 512 * 1024, `the stdout stream buffered ${peakBuffered} bytes`);
    assert.equal((await exec.finished()).exitCode, 0);
  });

  test("an unknown container is an error", async () => {
    await assert.rejects(client.exec("nope", ["x"]));
  });

  test("cancelling stops the stream with an error", async () => {
    engine.execs.set("app-db", { frames: [frame(1, "partial")], exitCode: 0 });
    const controller = new AbortController();
    const exec = await client.exec("app-db", ["x"], { signal: controller.signal });
    controller.abort();

    await assert.rejects(collect(exec.stdout), /cancelled|aborted|closed/i);
  });
});

describe("volume archives: read-only helper containers that are never started", () => {
  test("a volume is read through a network-less, read-only helper that is removed afterwards", async () => {
    engine.volumes.add("db-data");
    engine.archives.set("db-data", () => Readable.from([tarOf({ "./PG_VERSION": "16\n", "./base/1": "data" })]));
    const archive = await client.volumeArchive("db-data", { helperImage: "helper:local" });
    const files = untar(await collect(archive.stream));
    await archive.dispose();

    assert.equal(files["./PG_VERSION"]!.toString(), "16\n");

    const [created] = engine.created;
    assert.ok(created);
    const body = created.body as { Image: string; Labels: Record<string, string>; NetworkDisabled: boolean; HostConfig: { Binds: string[]; ReadonlyRootfs: boolean; NetworkMode: string } };
    assert.equal(body.Image, "helper:local");
    assert.deepEqual(body.HostConfig.Binds, ["db-data:/src:ro"], "the volume is bound READ-ONLY");
    assert.equal(body.HostConfig.ReadonlyRootfs, true);
    assert.equal(body.HostConfig.NetworkMode, "none");
    assert.equal(body.NetworkDisabled, true);
    assert.equal(body.Labels[LABEL_MIGRATION_TOOL], HELPER_LABEL_VALUE);

    assert.equal(engine.calls(/POST \/containers\/helper\d+\/start/).length, 0, "the helper is never started");
    assert.equal(engine.calls(/GET \/containers\/helper\d+\/archive/)[0]!.query.get("path"), "/src/.");
    const removal = engine.calls(/DELETE \/containers\/helper\d+/)[0]!;
    assert.equal(removal.query.get("v"), "false", "never remove volumes");
    assert.equal(removal.query.get("force"), "true");
    assert.equal(engine.containers.has(created.id), false);
  });

  test("a volume that does not exist is refused BEFORE any container is created (a bind would create it)", async () => {
    await assert.rejects(client.volumeArchive("ghost-volume", { helperImage: "helper:local" }), /does not exist; refusing to create it/);
    assert.equal(engine.calls(/POST \/containers\/create/).length, 0);
  });

  test("if reading the archive fails the helper is removed anyway", async () => {
    engine.volumes.add("db-data"); // exists, but the engine has no archive for it -> 404
    await assert.rejects(client.volumeArchive("db-data", { helperImage: "helper:local" }));

    assert.equal(engine.calls(/DELETE \/containers\/helper\d+/).length, 1);
    assert.equal([...engine.containers.values()].filter((c) => c.id.startsWith("helper")).length, 0);
  });

  test("a failed removal can be retried (dispose is only 'done' once it worked)", async () => {
    engine.volumes.add("db-data");
    engine.archives.set("db-data", () => Readable.from([tarOf({})]));
    const archive = await client.volumeArchive("db-data", { helperImage: "helper:local" });
    await collect(archive.stream);

    const helperId = engine.created[0]!.id;
    engine.overrides.set(`DELETE /containers/${helperId}`, 500);
    await assert.rejects(archive.dispose());

    engine.overrides.clear();
    await archive.dispose(); // retried, and this time it works
    assert.equal(engine.containers.has(helperId), false);
    await archive.dispose(); // and is idempotent afterwards
  });

  test("a large archive streams with backpressure through the real HTTP path", async () => {
    engine.volumes.add("db-data");
    engine.archives.set("db-data", () => lazyTar([syntheticEntry("./huge", 48 * 1024 * 1024, 4)]));
    const archive = await client.volumeArchive("db-data", { helperImage: "helper:local" });

    let bytes = 0;
    await pipeline(archive.stream, new Writable({ write(chunk: Buffer, _e, cb) { bytes += chunk.length; cb(); } }));
    await archive.dispose();

    assert.ok(bytes > 48 * 1024 * 1024);
  });
});

describe("helper runs, images and housekeeping", () => {
  test("runHelper creates a read-only, network-less container, starts it, reads its output and removes it", async () => {
    engine.helperLogs = Buffer.concat([frame(1, "Database cluster state:               shut down\n")]);
    const result = await client.runHelper({ image: "postgres:16", entrypoint: ["pg_controldata"], cmd: ["/var/lib/postgresql/data"], binds: ["db-data:/var/lib/postgresql/data:ro"], timeoutMs: 5000 });

    assert.deepEqual(result, { exitCode: 0, stdout: "Database cluster state:               shut down\n" });
    const body = engine.created[0]!.body as { Entrypoint: string[]; Cmd: string[]; HostConfig: { Binds: string[]; ReadonlyRootfs: boolean; NetworkMode: string } };
    assert.deepEqual(body.Entrypoint, ["pg_controldata"]);
    assert.deepEqual(body.HostConfig.Binds, ["db-data:/var/lib/postgresql/data:ro"]);
    assert.equal(body.HostConfig.ReadonlyRootfs, true);
    assert.equal(body.HostConfig.NetworkMode, "none");
    assert.equal(engine.calls(/DELETE \/containers\/helper/).length, 1, "removed even on success");
  });

  test("a failing helper still gets removed", async () => {
    engine.overrides.set("POST /containers/helper1/start", 500);
    await assert.rejects(client.runHelper({ image: "x", entrypoint: ["y"], cmd: [], binds: [], timeoutMs: 1000 }));

    assert.equal(engine.calls(/DELETE \/containers\/helper/).length, 1);
  });

  test("images are saved as a stream, and their ids are readable", async () => {
    engine.images.set("deployment-app-1:abc", { id: "sha256:cafe", tar: tarOf({ "manifest.json": "[]" }) });

    assert.equal(await client.imageId("deployment-app-1:abc"), "sha256:cafe");
    assert.equal(await client.imageId("nope:1"), null);
    assert.deepEqual(Object.keys(untar(await collect(await client.imageSave("deployment-app-1:abc")))), ["manifest.json"]);
    await assert.rejects(client.imageSave("nope:1"));
  });

  test("sweepHelpers removes only containers carrying the export-helper label", async () => {
    engine.containers.set("h-old", { id: "h-old", name: "h-old", running: false, labels: { [LABEL_MIGRATION_TOOL]: HELPER_LABEL_VALUE } });
    engine.containers.set("someone-elses", { id: "someone-elses", name: "someone-elses", running: false, labels: { other: "x" } });

    assert.equal(await client.sweepHelpers(), 1);
    assert.equal(engine.containers.has("h-old"), false);
    assert.equal(engine.containers.has("someone-elses"), true);
    assert.equal(engine.containers.has("app-db"), true, "application containers are never swept");
  });
});

describe("the client has no import or restore verbs", () => {
  test("it exposes only export operations", () => {
    assert.deepEqual(Object.keys(client).sort(), [
      "exec", "imageId", "imageSave", "inspectContainer", "pauseContainer", "runHelper", "startContainer", "stopContainer", "sweepHelpers", "unpauseContainer", "volumeArchive"
    ]);
  });

  test("no request it can make creates a volume or network, loads an image, or writes into a container", async () => {
    engine.volumes.add("db-data");
    engine.archives.set("db-data", () => Readable.from([tarOf({})]));
    engine.execs.set("app-db", { frames: [], exitCode: 0 });
    const archive = await client.volumeArchive("db-data", { helperImage: "h" });
    await collect(archive.stream);
    await archive.dispose();
    await client.stopContainer("app-db", 1);
    await client.startContainer("app-db");
    await collect((await client.exec("app-db", ["x"])).stdout);

    const forbidden = engine.requests.filter((r) => /^(POST \/volumes|POST \/networks|POST \/images\/load|POST \/build|PUT \/containers\/.+\/archive|POST \/images\/create)/.test(`${r.method} ${r.path}`));
    assert.deepEqual(forbidden.map((r) => `${r.method} ${r.path}`), []);
  });
});
