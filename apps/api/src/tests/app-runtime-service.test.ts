import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildManagedContainerRuntimeMap,
  resolveAppRuntime
} from "../services/app-runtime-service.js";

describe("buildManagedContainerRuntimeMap", () => {
  test("indexes managed containers by name (stripping the leading slash) with their live state", () => {
    const map = buildManagedContainerRuntimeMap([
      { names: ["/app-alpha"], state: "running", labels: { "com.deployment-platform.managed": "true" } },
      { names: ["/app-beta"], state: "exited", labels: { "com.deployment-platform.managed": "true" } }
    ]);

    assert.deepEqual(map.get("app-alpha"), { present: true, running: true, status: "running" });
    assert.deepEqual(map.get("app-beta"), { present: true, running: false, status: "exited" });
  });

  test("ignores unmanaged containers entirely", () => {
    const map = buildManagedContainerRuntimeMap([
      { names: ["/some-random-container"], state: "running", labels: {} },
      { names: ["/another"], state: "running", labels: undefined }
    ]);

    assert.equal(map.size, 0);
  });
});

describe("resolveAppRuntime", () => {
  const runningApp = buildManagedContainerRuntimeMap([
    { names: ["/app-live"], state: "running", labels: { "com.deployment-platform.managed": "true" } }
  ]);

  test("reports a present, running container", () => {
    assert.deepEqual(resolveAppRuntime("app-live", runningApp), {
      present: true,
      running: true,
      status: "running"
    });
  });

  test("a database-managed app whose container is absent is present:false — never running", () => {
    const runtime = resolveAppRuntime("app-gone", runningApp);
    assert.deepEqual(runtime, { present: false, running: false, status: null });
    assert.equal(runtime?.running, false);
  });

  test("a null map (Docker unreachable) yields null so the caller falls back to stored status, not a false 'missing'", () => {
    assert.equal(resolveAppRuntime("app-live", null), null);
  });

  test("an app with no container name at all is treated as missing, not running", () => {
    assert.deepEqual(resolveAppRuntime(null, runningApp), {
      present: false,
      running: false,
      status: null
    });
  });
});
