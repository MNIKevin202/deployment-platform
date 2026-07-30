import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildRoutes,
  createRoutingService,
  generateCaddyConfig,
  type CaddyOperations
} from "../services/routing-service.js";
import type { AppDatabase, StoredApp } from "../database.js";

function makeApp(overrides: Partial<StoredApp>): StoredApp {
  return {
    id: 1,
    name: "app-one",
    containerId: "abc123",
    containerName: "app-app-one",
    image: "nginx:alpine",
    containerPort: 80,
    domain: "app-one.apps.example.com",
    internalOnly: false,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDeployedAt: "2026-01-01T00:00:00.000Z",
    environmentTouchedAt: null,
    memoryLimitMb: null,
    cpuLimit: null,
    ...overrides
  };
}

/** A mutable control object so a test can change Caddy behaviour between runs. */
interface OpsControl {
  validateConfigFileOk: boolean;
  validateMainConfigOk: boolean;
  applyOk: boolean;
  verifyOk: boolean;
  applyDelayMs: number;
}

interface OpsCalls {
  validateConfigFile: number;
  validateMainConfig: number;
  apply: number;
  verify: number;
  maxApplyInFlight: number;
}

function makeOps(control: OpsControl): { ops: CaddyOperations; calls: OpsCalls } {
  const calls: OpsCalls = {
    validateConfigFile: 0,
    validateMainConfig: 0,
    apply: 0,
    verify: 0,
    maxApplyInFlight: 0
  };
  let applyInFlight = 0;
  return {
    calls,
    ops: {
      async validateConfigFile() {
        calls.validateConfigFile += 1;
        return { ok: control.validateConfigFileOk, output: control.validateConfigFileOk ? "" : "syntax error near line 1" };
      },
      async validateMainConfig() {
        calls.validateMainConfig += 1;
        return { ok: control.validateMainConfigOk, output: control.validateMainConfigOk ? "" : "merged validation failed" };
      },
      async apply() {
        calls.apply += 1;
        applyInFlight += 1;
        calls.maxApplyInFlight = Math.max(calls.maxApplyInFlight, applyInFlight);
        if (control.applyDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, control.applyDelayMs));
        }
        applyInFlight -= 1;
        return { ok: control.applyOk, output: control.applyOk ? "restarted" : "docker restart failed" };
      },
      async verify() {
        calls.verify += 1;
        return { ok: control.verifyOk, output: control.verifyOk ? "running" : "Caddy is not running after apply" };
      }
    }
  };
}

const tempDirs: string[] = [];
function tempRoutesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "routing-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fakeDb(apps: StoredApp[] | (() => StoredApp[])): AppDatabase {
  return { listApps: typeof apps === "function" ? apps : () => apps } as unknown as AppDatabase;
}

function buildService(
  options: {
    enabled?: boolean;
    control?: Partial<OpsControl>;
    routesDir?: string;
  } = {}
) {
  const control: OpsControl = {
    validateConfigFileOk: true,
    validateMainConfigOk: true,
    applyOk: true,
    verifyOk: true,
    applyDelayMs: 0,
    ...options.control
  };
  const { ops, calls } = makeOps(control);
  const routesDir = options.routesDir ?? tempRoutesDir();
  const service = createRoutingService({
    enabled: options.enabled ?? true,
    docker: {} as never,
    routesDirInApi: routesDir,
    routesDirInCaddy: "/etc/caddy/routes",
    caddyContainerName: "deployment-platform-caddy",
    mainCaddyfilePathInCaddy: "/etc/caddy/Caddyfile",
    appsFilename: "apps.caddy",
    operations: ops
  });
  return { service, routesDir, control, calls };
}

function readApps(routesDir: string): string {
  const path = join(routesDir, "apps.caddy");
  return existsSync(path) ? readFileSync(path, "utf8") : "__MISSING__";
}

describe("routing reconciliation", () => {
  test("first app route creation writes, validates, applies and verifies", async () => {
    const { service, routesDir, calls } = buildService();
    const status = await service.reconcile(fakeDb([makeApp({})]));

    assert.equal(status.lastReconcileSucceeded, true);
    assert.equal(status.active, true);
    assert.equal(status.routedAppCount, 1);
    assert.match(readApps(routesDir), /app-one\.apps\.example\.com \{/);
    assert.match(readApps(routesDir), /reverse_proxy app-app-one:80/);
    assert.equal(calls.apply, 1);
    assert.equal(calls.verify, 1);
  });

  test("second app route creation adds a block without dropping the first", async () => {
    const { service, routesDir } = buildService();
    const two = [
      makeApp({ id: 1, name: "app-one", domain: "app-one.apps.example.com", containerName: "app-app-one" }),
      makeApp({ id: 2, name: "app-two", domain: "app-two.apps.example.com", containerName: "app-app-two", containerPort: 8080 })
    ];
    const status = await service.reconcile(fakeDb(two));
    assert.equal(status.routedAppCount, 2);
    const config = readApps(routesDir);
    assert.match(config, /app-one\.apps\.example\.com \{/);
    assert.match(config, /reverse_proxy app-app-two:8080/);
  });

  test("route update re-applies with the new upstream", async () => {
    const { service, routesDir, calls } = buildService();
    await service.reconcile(fakeDb([makeApp({ containerPort: 80 })]));
    const status = await service.reconcile(fakeDb([makeApp({ containerPort: 3000 })]));
    assert.equal(status.lastReconcileSucceeded, true);
    assert.match(readApps(routesDir), /reverse_proxy app-app-one:3000/);
    assert.equal(calls.apply, 2);
  });

  test("route deletion empties the file and drops the route", async () => {
    const { service, routesDir } = buildService();
    await service.reconcile(fakeDb([makeApp({})]));
    const status = await service.reconcile(fakeDb([]));
    assert.equal(status.routedAppCount, 0);
    assert.equal(readApps(routesDir), "");
  });

  test("idempotent reconciliation does not restart Caddy a second time", async () => {
    const { service, routesDir, calls } = buildService();
    await service.reconcile(fakeDb([makeApp({})]));
    const first = readApps(routesDir);
    const status = await service.reconcile(fakeDb([makeApp({})]));
    assert.equal(status.lastReconcileSucceeded, true);
    assert.equal(readApps(routesDir), first);
    assert.equal(calls.apply, 1, "no second restart for identical desired config");
  });

  test("duplicate domain is rejected for all claimants", async () => {
    const { service, routesDir } = buildService();
    const dupes = [
      makeApp({ id: 1, name: "app-one", domain: "same.apps.example.com", containerName: "app-app-one" }),
      makeApp({ id: 2, name: "app-two", domain: "same.apps.example.com", containerName: "app-app-two" })
    ];
    const status = await service.reconcile(fakeDb(dupes));
    assert.equal(status.routedAppCount, 0);
    assert.equal(status.rejectedRouteCount, 2);
    assert.equal(readApps(routesDir), "");
    const built = buildRoutes(dupes);
    assert.ok(built.rejected.every((r) => r.reason.includes("duplicate domain")));
  });

  test("invalid domain is rejected", async () => {
    const built = buildRoutes([makeApp({ domain: "not_a valid domain" })]);
    assert.equal(built.routes.length, 0);
    assert.equal(built.rejected[0]?.reason, "invalid domain");
    assert.equal(built.config, "");
  });

  test("invalid upstream (container / port) is rejected", async () => {
    const badContainer = buildRoutes([makeApp({ containerName: "bad name;evil" })]);
    assert.equal(badContainer.rejected[0]?.reason, "invalid upstream container");
    const badPort = buildRoutes([makeApp({ containerPort: 70000 })]);
    assert.equal(badPort.rejected[0]?.reason, "invalid upstream port");
    const zeroPort = buildRoutes([makeApp({ containerPort: 0 })]);
    assert.equal(zeroPort.rejected[0]?.reason, "invalid upstream port");
  });

  test("candidate config validation failure aborts before touching the active file", async () => {
    const { service, routesDir, control, calls } = buildService();
    // Seed a good active config.
    await service.reconcile(fakeDb([makeApp({})]));
    const good = readApps(routesDir);
    const applyBefore = calls.apply;

    control.validateConfigFileOk = false;
    const status = await service.reconcile(fakeDb([makeApp({ containerPort: 3000 })]));
    assert.equal(status.lastReconcileSucceeded, false);
    assert.equal(status.active, false);
    assert.match(status.lastError ?? "", /failed validation/);
    // Active file untouched, Caddy not re-applied.
    assert.equal(readApps(routesDir), good);
    assert.equal(calls.apply, applyBefore);
  });

  test("rollback to the previous config when merged validation fails", async () => {
    const { service, routesDir, control } = buildService();
    await service.reconcile(fakeDb([makeApp({ containerPort: 80 })]));
    const previous = readApps(routesDir);

    control.validateMainConfigOk = false;
    const status = await service.reconcile(fakeDb([makeApp({ containerPort: 3000 })]));
    assert.equal(status.lastReconcileSucceeded, false);
    assert.equal(readApps(routesDir), previous, "previous known-good config restored");
  });

  test("Caddy apply failure restores previous config and re-applies it", async () => {
    const { service, routesDir, control, calls } = buildService();
    await service.reconcile(fakeDb([makeApp({ containerPort: 80 })]));
    const previous = readApps(routesDir);
    const applyAfterFirst = calls.apply;

    control.applyOk = false;
    const status = await service.reconcile(fakeDb([makeApp({ containerPort: 3000 })]));
    assert.equal(status.lastReconcileSucceeded, false);
    assert.equal(readApps(routesDir), previous);
    // One failed apply for the candidate + one recovery apply for the restore.
    assert.equal(calls.apply, applyAfterFirst + 2);
  });

  test("Caddy health verification failure rolls back", async () => {
    const { service, routesDir, control } = buildService();
    await service.reconcile(fakeDb([makeApp({ containerPort: 80 })]));
    const previous = readApps(routesDir);

    control.verifyOk = false;
    const status = await service.reconcile(fakeDb([makeApp({ containerPort: 3000 })]));
    assert.equal(status.lastReconcileSucceeded, false);
    assert.equal(status.active, false);
    assert.equal(readApps(routesDir), previous);
  });

  test("concurrent reconciliation is serialized (never two applies in flight)", async () => {
    let call = 0;
    const appsByCall = [
      [makeApp({ id: 1, name: "app-one", domain: "app-one.apps.example.com", containerName: "app-app-one" })],
      [makeApp({ id: 2, name: "app-two", domain: "app-two.apps.example.com", containerName: "app-app-two" })]
    ];
    const { service, routesDir, calls } = buildService({ control: { applyDelayMs: 40 } });
    const db = fakeDb(() => appsByCall[Math.min(call++, appsByCall.length - 1)]!);

    const [a, b] = await Promise.all([service.reconcile(db), service.reconcile(db)]);
    assert.equal(a.lastReconcileSucceeded, true);
    assert.equal(b.lastReconcileSucceeded, true);
    assert.equal(calls.maxApplyInFlight, 1, "applies must not overlap");
    // The file is one coherent config, not an interleaved mash.
    assert.match(readApps(routesDir), /app-two\.apps\.example\.com \{/);
  });

  test("panel routing is never emitted into app route files", () => {
    const config = generateCaddyConfig([
      makeApp({ domain: "panel.devminted.com", name: "panel", containerName: "deployment-platform-web" })
    ]);
    // The panel domain lives in the main Caddyfile, not apps.caddy; even if an
    // app were named to collide, the app file only ever contains reverse_proxy
    // site blocks — never handle_path, admin, or the API upstream directives.
    assert.doesNotMatch(config, /handle_path/);
    assert.doesNotMatch(config, /admin/);
    assert.doesNotMatch(config, /import /);
  });

  test("unrelated managed route files in the directory are preserved", async () => {
    const routesDir = tempRoutesDir();
    const sibling = join(routesDir, "legacy.caddy");
    writeFileSync(sibling, "legacy.example.com {\n\trespond 200\n}\n");
    const { service } = buildService({ routesDir });
    await service.reconcile(fakeDb([makeApp({})]));
    assert.ok(existsSync(sibling), "sibling route file untouched");
    assert.equal(readFileSync(sibling, "utf8"), "legacy.example.com {\n\trespond 200\n}\n");
  });

  test("app routes persist on disk to survive a Caddy restart", async () => {
    const { service, routesDir } = buildService();
    await service.reconcile(fakeDb([makeApp({})]));
    // The route lives in a real file imported by the Caddyfile, so a container
    // restart re-reads it — persistence is the file still being present.
    assert.match(readApps(routesDir), /reverse_proxy app-app-one:80/);
  });

  test("routing status is accurate across states", async () => {
    // Disabled.
    const disabled = buildService({ enabled: false });
    const dstatus = await disabled.service.reconcile(fakeDb([makeApp({})]));
    assert.equal(dstatus.enabled, false);
    assert.equal(dstatus.active, false);
    assert.match(dstatus.lastError ?? "", /disabled/i);

    // Enabled + healthy.
    const enabled = buildService();
    assert.equal(enabled.service.getStatus().active, false, "not active before any reconcile");
    const estatus = await enabled.service.reconcile(fakeDb([makeApp({})]));
    assert.equal(estatus.enabled, true);
    assert.equal(estatus.active, true);
    assert.equal(estatus.routedAppCount, 1);
  });

  test("admin API is not required: apply path uses restart, config has no admin directive", async () => {
    const { service, calls } = buildService();
    const status = await service.reconcile(fakeDb([makeApp({})]));
    // Reconcile succeeded purely through the injected apply()/verify() (restart
    // + health), never an admin-API reload, and the generated config declares
    // no global/admin options.
    assert.equal(status.active, true);
    assert.equal(calls.apply, 1);
    assert.doesNotMatch(generateCaddyConfig([makeApp({})]), /admin/);
  });

  test("no arbitrary Caddy directive can be injected via domain or upstream", () => {
    const injectionDomain = buildRoutes([
      makeApp({ domain: "evil.example.com {\n\trespond 200\n}\n#" })
    ]);
    assert.equal(injectionDomain.routes.length, 0);
    assert.equal(injectionDomain.rejected[0]?.reason, "invalid domain");

    const injectionUpstream = buildRoutes([
      makeApp({ containerName: "app } \n respond 500 \n {" })
    ]);
    assert.equal(injectionUpstream.routes.length, 0);
    assert.equal(injectionUpstream.rejected[0]?.reason, "invalid upstream container");

    // A fully valid pair produces only the expected 4-line site block.
    const clean = buildRoutes([makeApp({})]);
    assert.equal(clean.config, "app-one.apps.example.com {\n\tencode zstd gzip\n\treverse_proxy app-app-one:80\n}\n");
  });
});
