import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_OPTIONS, planExport, stopOrder, type ExportOptions, type ExportPlan } from "../migration/export-plan.js";
import type { ExportContainerInfo } from "../migration/export-docker.js";
import type { PlatformFacts } from "../migration/facts.js";
import { hookCovers, parseHooksFile, presetFor } from "../migration/hooks.js";
import { FakeExportDocker } from "./export-fakes.js";
import { MIB } from "./migration-env-fixtures.js";
import { makeApp, makeFacts } from "./migration-fixtures.js";

interface Scenario {
  options?: Partial<ExportOptions>;
  facts?: PlatformFacts;
  stopped?: string[];
  missing?: string[];
  mounts?: Record<string, Array<{ type: "volume" | "bind"; name?: string; source?: string; destination: string }>>;
  volumeSizes?: Record<string, number | null>;
  freeBytes?: number | null;
  hostPaths?: { config: boolean; routes: boolean };
}

async function plan(scenario: Scenario = {}): Promise<ExportPlan> {
  const facts = scenario.facts ?? makeFacts();
  const fake = new FakeExportDocker();
  for (const app of facts.apps) {
    if (!(scenario.missing ?? []).includes(app.containerName)) {
      fake.addContainer({
        name: app.containerName,
        image: app.image,
        running: !(scenario.stopped ?? []).includes(app.containerName),
        mounts: scenario.mounts?.[app.containerName] ?? app.volumes.map((v) => ({ type: "volume" as const, name: v.volumeName, destination: v.containerPath }))
      });
    }
  }

  const containers = new Map<number, ExportContainerInfo | null>();
  for (const app of facts.apps) {
    containers.set(app.id, await fake.inspectContainer(app.containerName));
  }

  const volumeSizes = new Map<string, number | null>();
  for (const app of facts.apps) {
    for (const volume of app.volumes) {
      volumeSizes.set(volume.volumeName, scenario.volumeSizes?.[volume.volumeName] === undefined ? (volume.volumeName === "db-data" ? 50 * MIB : 5 * MIB) : scenario.volumeSizes[volume.volumeName]!);
    }
  }
  for (const [name, size] of Object.entries(scenario.volumeSizes ?? {})) {
    volumeSizes.set(name, size);
  }

  return planExport({
    facts,
    containers,
    usage: {
      volumeSizes: volumeSizes as Map<string, number | null>,
      imageSizes: new Map([["deployment-app-1:abc123def456", 100 * MIB], ["deployment-app-1:000111222333", 100 * MIB]])
    },
    localImageTags: new Set(["deployment-app-1:abc123def456", "deployment-app-1:000111222333", "nginx:alpine", "postgres:16"]),
    options: { ...DEFAULT_OPTIONS, ...scenario.options, strategies: { ...DEFAULT_OPTIONS.strategies, ...scenario.options?.strategies } },
    dbSizeBytes: 2 * MIB,
    hostPaths: scenario.hostPaths ?? { config: true, routes: true },
    outputFreeBytes: scenario.freeBytes === undefined ? null : scenario.freeBytes
  });
}

const appPlan = (p: ExportPlan, name: string) => p.apps.find((app) => app.name === name)!;
const codes = (p: ExportPlan) => p.refusals.map((r) => r.code);

describe("strategy selection", () => {
  test("rehearsal: a database gets a verified dump (no disruption); unknown data is copied live; stateless apps are untouched", async () => {
    const p = await plan();

    assert.equal(appPlan(p, "db").strategy, "hook");
    assert.equal(appPlan(p, "db").volumes[0]!.method, "dump");
    assert.equal(appPlan(p, "db").volumes[0]!.expectedLevel, "application-consistent");
    assert.equal(appPlan(p, "db").volumes[0]!.hook?.id, "postgres");
    assert.equal(appPlan(p, "web").strategy, "live");
    assert.equal(appPlan(p, "web").volumes[0]!.expectedLevel, "inconsistent");
    assert.equal(appPlan(p, "worker").strategy, "none");
    assert.equal(appPlan(p, "static").strategy, "none");
    assert.deepEqual(p.refusals, []);
    assert.deepEqual(p.windows, []); // nothing is stopped or paused
    assert.ok(p.warnings.some((w) => /"web" will be captured as inconsistent/.test(w)));
  });

  test("cutover: a database still gets a verified dump; unknown data needs a stop AND evidence or acceptance", async () => {
    const p = await plan({ options: { mode: "cutover" } });

    assert.equal(appPlan(p, "db").strategy, "hook");
    assert.equal(appPlan(p, "web").strategy, "stop");
    assert.deepEqual(codes(p), ["consistency-evidence-required"]);
    assert.equal(p.refusals[0]!.subject, "app:1");
    assert.match(p.refusals[0]!.message, /quiesced-unverified.*not application consistency/);
    assert.match(p.refusals[0]!.remedy, /--accept-risk web=quiesced-unverified/);
  });

  test("an explicit, recorded risk acceptance lets cutover proceed — and is carried into the plan", async () => {
    const p = await plan({ options: { mode: "cutover", acceptRisks: { web: "quiesced-unverified" } } });

    assert.deepEqual(p.refusals, []);
    assert.equal(appPlan(p, "web").acceptedRisk, "quiesced-unverified");
    assert.equal(appPlan(p, "db").acceptedRisk, null); // it has real evidence; nothing to accept
  });

  test("accepting a WEAKER level than the plan achieves is still fine; the app ref works as well as the name", async () => {
    const p = await plan({ options: { mode: "cutover", acceptRisks: { "app:1": "crash-consistent" } } });

    assert.deepEqual(p.refusals, []);
  });

  test("a live copy is never acceptable at cutover, even with an acceptance on file", async () => {
    const p = await plan({
      options: { mode: "cutover", strategies: { default: "auto", perApp: { web: "live" } }, acceptRisks: { web: "inconsistent" } }
    });

    assert.ok(codes(p).includes("live-copy-not-allowed"));
  });

  test("a PostgreSQL stop is judged on the evidence it will produce: conditional, not assumed", async () => {
    const p = await plan({ options: { mode: "cutover", strategies: { default: "auto", perApp: { db: "stop" } }, acceptRisks: { web: "quiesced-unverified" } } });
    const volume = appPlan(p, "db").volumes[0]!;

    assert.equal(volume.strategy, "stop");
    assert.equal(volume.shutdownCheck, "postgres");
    assert.equal(volume.conditional, true);
    assert.equal(volume.expectedLevel, "application-consistent");
    assert.deepEqual(p.refusals, []);
  });

  test("a stop on MySQL has no verification available, so cutover demands acceptance", async () => {
    const facts = makeFacts();
    facts.apps[1] = { ...facts.apps[1]!, image: "mysql:8", volumes: [{ volumeName: "db-data", containerPath: "/var/lib/mysql", readOnly: false }] };
    const p = await plan({ facts, options: { mode: "cutover", strategies: { default: "auto", perApp: { db: "stop" } }, acceptRisks: { web: "quiesced-unverified" } } });

    assert.equal(appPlan(p, "db").volumes[0]!.shutdownCheck, null);
    assert.ok(p.refusals.some((r) => r.subject === "app:2" && r.code === "consistency-evidence-required"));
  });

  test("a freeze is crash-consistent: acceptable for rehearsal, not for a database at cutover", async () => {
    const rehearsal = await plan({ options: { strategies: { default: "freeze", perApp: {} } } });
    assert.deepEqual(rehearsal.refusals, []);
    assert.equal(appPlan(rehearsal, "web").volumes[0]!.expectedLevel, "crash-consistent");

    const cutover = await plan({ options: { mode: "cutover", strategies: { default: "freeze", perApp: {} } } });
    assert.equal(cutover.refusals.filter((r) => r.code === "consistency-evidence-required").length, 2);
  });
});

describe("hooks", () => {
  test("only databases with a verifiable completion marker have a built-in hook", () => {
    for (const kind of ["postgres", "mysql", "mariadb"] as const) {
      assert.ok(presetFor(kind)?.trailer, kind);
    }
    for (const kind of ["mongodb", "redis", "unknown-stateful", "stateless"] as const) {
      assert.equal(presetFor(kind), null, `${kind} must not have a preset: no verifiable marker`);
    }
  });

  test("hookCovers matches by path prefix and the wildcard", () => {
    const pg = presetFor("postgres")!;

    assert.ok(hookCovers(pg, "/var/lib/postgresql/data"));
    assert.ok(hookCovers(pg, "/var/lib/postgresql"));
    assert.ok(!hookCovers(pg, "/var/lib/postgresqlevil"));
    assert.ok(!hookCovers(pg, "/backups"));
    assert.ok(hookCovers({ ...pg, covers: ["*"] }, "/anything"));
  });

  test("an operator hook must say how its output is verified", () => {
    assert.throws(() => parseHooksFile(JSON.stringify({ web: { cmd: ["sh", "-c", "dump"] } })), /how its output is verified/);
    assert.throws(() => parseHooksFile(JSON.stringify({ web: { cmd: ["x"], trailer: "(unclosed" } })), /not a valid regular expression/);
    assert.throws(() => parseHooksFile(JSON.stringify({ web: { cmd: ["x"], trailer: "ok", surprise: 1 } })));

    const parsed = parseHooksFile(JSON.stringify({ web: { cmd: ["sh", "-c", "dump"], trailer: "^-- end$" }, "app:2": { cmd: ["d"], exitStatusOnly: true, covers: ["/data"] } }));
    assert.equal(parsed.web!.covers[0], "*");
    assert.equal(parsed["app:2"]!.exitStatusOnly, true);
  });

  test("a custom hook turns an unknown-stateful app into a verified-dump app", async () => {
    const hooks = parseHooksFile(JSON.stringify({ web: { cmd: ["sh", "-c", "dump"], trailer: "-- complete" } }));
    const p = await plan({ options: { mode: "cutover", hooks } });

    assert.equal(appPlan(p, "web").strategy, "hook");
    assert.equal(appPlan(p, "web").volumes[0]!.hook?.id, "custom");
    assert.deepEqual(p.refusals, []);
  });

  test("requesting a hook that does not exist, does not cover the volumes, or has nothing running is refused", async () => {
    const noHook = await plan({ options: { strategies: { default: "auto", perApp: { web: "hook" } } } });
    assert.ok(codes(noHook).includes("hook-unavailable"));

    const facts = makeFacts();
    facts.apps[1] = { ...facts.apps[1]!, volumes: [...facts.apps[1]!.volumes, { volumeName: "db-backups", containerPath: "/backups", readOnly: false }] };
    const notCovering = await plan({ facts, options: { strategies: { default: "auto", perApp: { db: "hook" } } } });
    assert.ok(codes(notCovering).includes("hook-not-covering"));
    assert.match(notCovering.refusals.find((r) => r.code === "hook-not-covering")!.message, /\/backups/);

    const stopped = await plan({ stopped: ["app-db"], options: { strategies: { default: "auto", perApp: { db: "hook" } } } });
    assert.ok(codes(stopped).includes("app-not-running"));
  });
});

describe("dependencies and unexported data", () => {
  test("a move that strands a dependency is refused up front; including it fixes that", async () => {
    const options = { scope: "application" as const, operation: "move" as const, appId: 1 };
    const blocked = await plan({ options });

    assert.ok(codes(blocked).includes("unresolved-dependencies"));
    assert.match(blocked.refusals.find((r) => r.code === "unresolved-dependencies")!.remedy, /app:2/);

    const ok = await plan({ options: { ...options, selection: [2, 3] } });
    assert.ok(!codes(ok).includes("unresolved-dependencies"));
    assert.deepEqual(ok.apps.map((a) => a.name), ["web", "db", "worker"]);
    assert.ok(ok.warnings.some((w) => /external database is shared/.test(w)));
  });

  test("a plain backup only warns about dependencies — it is not a migration", async () => {
    const p = await plan({ options: { scope: "application", operation: "backup", appId: 1 } });

    assert.ok(!codes(p).includes("unresolved-dependencies"));
    assert.ok(p.warnings.some((w) => /Unresolved dependencies/.test(w)));
  });

  test("an unknown app is refused", async () => {
    assert.deepEqual(codes(await plan({ options: { scope: "application", appId: 99 } })), ["unknown-app"]);
  });

  const withBind = { "app-web": [{ type: "volume" as const, name: "web-uploads", destination: "/uploads" }, { type: "bind" as const, source: "/srv/x", destination: "/host-data" }, { type: "volume" as const, name: "mystery-vol", destination: "/mystery" }] };

  test("bind mounts and unrecorded volumes are reported, never silently dropped", async () => {
    const p = await plan({ mounts: withBind });
    const kinds = appPlan(p, "web").unexported.map((item) => [item.kind, item.destination]);

    assert.deepEqual(kinds, [["bind-mount", "/host-data"], ["unrecorded-volume", "/mystery"]]);
    assert.ok(p.warnings.some((w) => /NOT exported.*\/host-data/.test(w)));
    assert.ok(!codes(p).includes("unexported-mounts")); // a rehearsal may proceed
  });

  test("at cutover, data that cannot be carried blocks the export unless explicitly allowed", async () => {
    const options = { mode: "cutover" as const, acceptRisks: { web: "quiesced-unverified" as const } };
    const refused = await plan({ mounts: withBind, options });
    assert.ok(codes(refused).includes("unexported-mounts"));

    const allowed = await plan({ mounts: withBind, options: { ...options, allowUnexported: true } });
    assert.ok(!codes(allowed).includes("unexported-mounts"));
  });
});

describe("quiesce windows", () => {
  test("dependents are stopped before the services they use", () => {
    const facts = makeFacts();

    // worker(3) uses web(1) uses db(2)
    assert.deepEqual(stopOrder(facts, [1, 2, 3]), [3, 1, 2]);
    assert.deepEqual(stopOrder(facts, [2, 1]), [1, 2]);
    assert.deepEqual(stopOrder(facts, [4, 2]), [2, 4]); // unrelated apps: lowest id first
  });

  test("a dependency cycle cannot hang the planner", () => {
    const facts = makeFacts({
      apps: [
        makeApp({ id: 1, name: "a", env: [{ key: "X", value: "http://app-b", isSecret: false, enabled: true }] }),
        makeApp({ id: 2, name: "b", env: [{ key: "X", value: "http://app-a", isSecret: false, enabled: true }] })
      ]
    });

    assert.deepEqual(stopOrder(facts, [1, 2]).sort(), [1, 2]);
  });

  const stopAll = { strategies: { default: "stop" as const, perApp: {} }, acceptRisks: { web: "quiesced-unverified" as const, db: "quiesced-unverified" as const } };

  test("group mode quiesces everything in ONE window, dependents first", async () => {
    const p = await plan({ options: { ...stopAll, mode: "cutover", quiesce: "group" } });

    assert.deepEqual(p.windows, [{ apps: ["app:1", "app:2"] }]);
  });

  test("sequential mode gives each app its own, shorter window", async () => {
    const p = await plan({ options: { ...stopAll, mode: "cutover", quiesce: "sequential" } });

    assert.deepEqual(p.windows, [{ apps: ["app:1"] }, { apps: ["app:2"] }]);
  });

  test("hook, live and stateless apps never appear in a window", async () => {
    assert.deepEqual((await plan()).windows, []);
  });
});

describe("disk space and platform scope", () => {
  test("the estimate bounds volumes, images and the database; too little free space is refused before anything is touched", async () => {
    const p = await plan({ freeBytes: 10 * MIB });

    assert.ok(p.estimates.upperBoundBytes >= 55 * MIB + 200 * MIB);
    assert.ok(p.estimates.requiredFreeBytes > p.estimates.upperBoundBytes);
    assert.ok(codes(p).includes("insufficient-disk"));
    assert.match(p.refusals.find((r) => r.code === "insufficient-disk")!.remedy, /Free at least/);

    assert.ok(!codes(await plan({ freeBytes: 10 * 1024 * MIB })).includes("insufficient-disk"));
    assert.ok(!codes(await plan({ freeBytes: null })).includes("insufficient-disk"));
  });

  test("unsized volumes are called out rather than assumed to be small", async () => {
    const p = await plan({ volumeSizes: { "web-uploads": null } });

    assert.equal(p.estimates.unknownSizeItems, 1);
    assert.ok(p.warnings.some((w) => /could not be sized/.test(w)));
  });

  test("platform scope exports the database, config and routes; missing config is refused", async () => {
    const ok = await plan({ options: { scope: "platform" } });
    assert.deepEqual(ok.platform, { database: true, config: true, routes: true });

    const noConfig = await plan({ options: { scope: "platform" }, hostPaths: { config: false, routes: true } });
    assert.ok(codes(noConfig).includes("config-unavailable"));

    const noRoutes = await plan({ options: { scope: "platform" }, hostPaths: { config: true, routes: false } });
    assert.ok(!codes(noRoutes).includes("config-unavailable"));
    assert.ok(noRoutes.warnings.some((w) => /routes/.test(w)));

    assert.deepEqual((await plan({ options: { scope: "application", appId: 4 } })).platform, { database: false, config: false, routes: false });
  });

  test("local build images are carried (current and rollback); registry images only on request", async () => {
    const p = await plan();
    assert.deepEqual(appPlan(p, "web").images.map((i) => [i.tag, i.role]), [["deployment-app-1:abc123def456", "current"], ["deployment-app-1:000111222333", "rollback"]]);
    assert.deepEqual(appPlan(p, "db").images, []);

    const withRegistry = await plan({ options: { includeRegistryImages: true } });
    assert.deepEqual(appPlan(withRegistry, "db").images.map((i) => [i.tag, i.role]), [["postgres:16", "dependency"]]);
  });
});
