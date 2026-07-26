import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildContainerEnvArray,
  buildEffectiveEnvironment,
  computeEnvironmentStatus
} from "../services/environment-service.js";
import type {
  StoredAppEnvVar,
  StoredGlobalEnvVar
} from "../environment-database.js";

function makeGlobalVar(
  overrides: Partial<StoredGlobalEnvVar> = {}
): StoredGlobalEnvVar {
  return {
    id: 1,
    key: "TZ",
    value: "America/New_York",
    isSecret: false,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeAppVar(
  overrides: Partial<StoredAppEnvVar> = {}
): StoredAppEnvVar {
  return {
    id: 1,
    appId: 1,
    key: "PORT",
    value: "3000",
    isSecret: false,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("buildEffectiveEnvironment", () => {
  test("merges globals and app variables, app wins on collision", () => {
    const globals = [
      makeGlobalVar({ key: "TZ", value: "America/New_York" }),
      makeGlobalVar({ id: 2, key: "NODE_ENV", value: "production" }),
      makeGlobalVar({ id: 3, key: "API_URL", value: "https://global.example.com" })
    ];

    const appVars = [
      makeAppVar({ key: "API_URL", value: "https://special.example.com" }),
      makeAppVar({ id: 2, key: "PORT", value: "3000" })
    ];

    const effective = buildEffectiveEnvironment(globals, appVars);
    const byKey = new Map(effective.map((v) => [v.key, v]));

    assert.equal(byKey.get("TZ")?.value, "America/New_York");
    assert.equal(byKey.get("TZ")?.source, "global");

    assert.equal(byKey.get("NODE_ENV")?.value, "production");
    assert.equal(byKey.get("NODE_ENV")?.source, "global");

    assert.equal(byKey.get("API_URL")?.value, "https://special.example.com");
    assert.equal(byKey.get("API_URL")?.source, "app-override");

    assert.equal(byKey.get("PORT")?.value, "3000");
    assert.equal(byKey.get("PORT")?.source, "app");

    assert.equal(effective.length, 4);
  });

  test("excludes disabled variables from either scope", () => {
    const globals = [makeGlobalVar({ enabled: false })];
    const appVars = [makeAppVar({ enabled: false })];

    const effective = buildEffectiveEnvironment(globals, appVars);
    assert.equal(effective.length, 0);
  });

  test("masks secret values but reports hasValue", () => {
    const globals = [
      makeGlobalVar({ key: "DB_PASSWORD", value: "hunter2", isSecret: true })
    ];

    const effective = buildEffectiveEnvironment(globals, []);

    assert.equal(effective[0].value, null);
    assert.equal(effective[0].hasValue, true);
    assert.equal(effective[0].isSecret, true);
  });

  test("returns an empty array when nothing is enabled", () => {
    assert.deepEqual(buildEffectiveEnvironment([], []), []);
  });
});

describe("buildContainerEnvArray", () => {
  test("produces KEY=value pairs with app values overriding global ones", () => {
    const globals = [
      makeGlobalVar({ key: "TZ", value: "America/New_York" }),
      makeGlobalVar({ id: 2, key: "API_URL", value: "https://global.example.com" })
    ];

    const appVars = [makeAppVar({ key: "API_URL", value: "https://special.example.com" })];

    const env = buildContainerEnvArray(globals, appVars);

    assert.ok(env.includes("TZ=America/New_York"));
    assert.ok(env.includes("API_URL=https://special.example.com"));
    assert.ok(!env.includes("API_URL=https://global.example.com"));
    assert.equal(env.length, 2);
  });

  test("excludes disabled variables", () => {
    const globals = [makeGlobalVar({ enabled: false })];
    const env = buildContainerEnvArray(globals, []);
    assert.deepEqual(env, []);
  });

  test("returns real secret values (never masked) for container injection", () => {
    const globals = [
      makeGlobalVar({ key: "DB_PASSWORD", value: "hunter2", isSecret: true })
    ];

    const env = buildContainerEnvArray(globals, []);
    assert.deepEqual(env, ["DB_PASSWORD=hunter2"]);
  });
});

describe("computeEnvironmentStatus", () => {
  test("is applied when the environment has never been touched", () => {
    assert.equal(
      computeEnvironmentStatus("2026-01-01T00:00:00.000Z", null),
      "applied"
    );
  });

  test("is pending when touched after the last deployment", () => {
    assert.equal(
      computeEnvironmentStatus(
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z"
      ),
      "pending"
    );
  });

  test("is applied when touched before the last deployment", () => {
    assert.equal(
      computeEnvironmentStatus(
        "2026-01-02T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      ),
      "applied"
    );
  });

  test("is pending when touched but never deployed", () => {
    assert.equal(
      computeEnvironmentStatus(null, "2026-01-01T00:00:00.000Z"),
      "pending"
    );
  });
});
