import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  companionIdempotencyKey,
  deployTemplateStack,
  type DeployTemplateStackDependencies
} from "../services/template-deployment-service.js";
import type {
  CreateAppServiceResult,
  CreateAppWithConfigInput,
  CreatedAppSummary
} from "../services/app-creation-service.js";

function summary(id: number, name: string): CreatedAppSummary {
  return {
    id,
    name,
    containerName: `app-${name}`,
    image: "example:1",
    containerPort: 8080,
    domain: null,
    internalOnly: true,
    containerId: `container-${id}`,
    status: "running",
    routingReady: true,
    environmentVariableCount: 0,
    secretVariableCount: 0,
    storageMountCount: 0
  };
}

function mainInput(overrides: Partial<CreateAppWithConfigInput> = {}): CreateAppWithConfigInput {
  return {
    name: "blueprint",
    image: "ghcr.io/open-webui/open-webui:0.11.0",
    containerPort: 8080,
    ...overrides
  };
}

const ollamaCompanion = {
  name: "blueprint-ollama",
  image: "ollama/ollama:0.32.5",
  containerPort: 11434,
  internalOnly: true,
  storageMounts: [{ containerPath: "/root/.ollama", readOnly: false }]
};

/** Records every create/remove call so ordering can be asserted precisely. */
function recordingDeps(
  createImpl: (input: CreateAppWithConfigInput) => Promise<CreateAppServiceResult>
): DeployTemplateStackDependencies & {
  created: string[];
  removed: number[];
  createInputs: CreateAppWithConfigInput[];
} {
  const created: string[] = [];
  const removed: number[] = [];
  const createInputs: CreateAppWithConfigInput[] = [];

  return {
    created,
    removed,
    createInputs,
    async createApp(input) {
      createInputs.push(input);
      const result = await createImpl(input);
      if (result.success && result.app) {
        created.push(input.name);
      }
      return result;
    },
    async removeApp(appId) {
      removed.push(appId);
      return true;
    }
  };
}

describe("deployTemplateStack", () => {
  test("creates companions before the main app and reports both", async () => {
    let nextId = 1;
    const deps = recordingDeps(async (input) => ({
      success: true,
      message: "App created successfully.",
      app: summary(nextId++, input.name)
    }));

    const result = await deployTemplateStack(deps, {
      main: mainInput(),
      companions: [ollamaCompanion]
    });

    assert.equal(result.success, true);
    assert.deepEqual(deps.created, ["blueprint-ollama", "blueprint"]);
    assert.equal(result.app?.name, "blueprint");
    assert.deepEqual(
      result.companions?.map((companion) => companion.name),
      ["blueprint-ollama"]
    );
    assert.equal(deps.removed.length, 0, "nothing is rolled back on success");
  });

  test("a companion is created internal-only and publishes no host ports", async () => {
    const deps = recordingDeps(async (input) => ({
      success: true,
      message: "ok",
      app: summary(1, input.name)
    }));

    await deployTemplateStack(deps, {
      main: mainInput(),
      companions: [ollamaCompanion]
    });

    const companionInput = deps.createInputs.find((i) => i.name === "blueprint-ollama");
    assert.ok(companionInput);
    assert.equal(companionInput.internalOnly, true);
    assert.deepEqual(companionInput.publishedPorts, []);
    assert.deepEqual(companionInput.storageMounts, [
      { containerPath: "/root/.ollama", readOnly: false }
    ]);
  });

  test("a companion defaults to internal-only when the template doesn't say", async () => {
    const deps = recordingDeps(async (input) => ({
      success: true,
      message: "ok",
      app: summary(1, input.name)
    }));

    await deployTemplateStack(deps, {
      main: mainInput(),
      companions: [{ name: "side", image: "x:1", containerPort: 1234 }]
    });

    const companionInput = deps.createInputs.find((i) => i.name === "side");
    assert.equal(companionInput?.internalOnly, true);
  });

  test("rolls the companion back when the main app fails to create", async () => {
    const deps = recordingDeps(async (input) => {
      if (input.name === "blueprint") {
        return { success: false, statusCode: 409, message: "An app named \"blueprint\" already exists" };
      }
      return { success: true, message: "ok", app: summary(7, input.name) };
    });

    const result = await deployTemplateStack(deps, {
      main: mainInput(),
      companions: [ollamaCompanion]
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 409);
    assert.deepEqual(deps.removed, [7], "the already-created companion is removed again");
    assert.equal(result.rollback?.attempted, 1);
    assert.equal(result.rollback?.removed, 1);
    assert.deepEqual(result.rollback?.leftover, []);
    assert.match(result.message, /already exists/);
    assert.match(result.message, /were removed again/);
  });

  test("a failing companion stops the install and never creates the main app", async () => {
    const deps = recordingDeps(async (input) => {
      if (input.name === "blueprint-ollama") {
        return { success: false, statusCode: 502, message: "image pull failed" };
      }
      return { success: true, message: "ok", app: summary(1, input.name) };
    });

    const result = await deployTemplateStack(deps, {
      main: mainInput(),
      companions: [ollamaCompanion]
    });

    assert.equal(result.success, false);
    assert.equal(deps.created.length, 0);
    assert.ok(
      !deps.createInputs.some((input) => input.name === "blueprint"),
      "the main app is never attempted after a companion fails"
    );
    assert.match(result.message, /image pull failed/);
  });

  test("reports apps that could not be rolled back instead of claiming success", async () => {
    const deps: DeployTemplateStackDependencies = {
      async createApp(input) {
        if (input.name === "blueprint") {
          return { success: false, statusCode: 502, message: "docker exploded" };
        }
        return { success: true, message: "ok", app: summary(3, input.name) };
      },
      async removeApp() {
        return false;
      }
    };

    const result = await deployTemplateStack(deps, {
      main: mainInput(),
      companions: [ollamaCompanion]
    });

    assert.equal(result.success, false);
    assert.deepEqual(result.rollback?.leftover, ["blueprint-ollama"]);
    assert.match(result.message, /manual cleanup/);
  });

  test("a thrown creation error is caught, rolled back, and reported", async () => {
    const deps = recordingDeps(async (input) => {
      if (input.name === "blueprint") {
        throw new Error("connection reset");
      }
      return { success: true, message: "ok", app: summary(9, input.name) };
    });

    const result = await deployTemplateStack(deps, {
      main: mainInput(),
      companions: [ollamaCompanion]
    });

    assert.equal(result.success, false);
    assert.match(result.message, /connection reset/);
    assert.deepEqual(deps.removed, [9]);
  });

  test("derives a distinct idempotency key per companion from the caller's key", async () => {
    const deps = recordingDeps(async (input) => ({
      success: true,
      message: "ok",
      app: summary(1, input.name)
    }));

    await deployTemplateStack(deps, {
      main: mainInput({ idempotencyKey: "abc-123" }),
      companions: [ollamaCompanion]
    });

    const companionInput = deps.createInputs.find((i) => i.name === "blueprint-ollama");
    assert.equal(companionInput?.idempotencyKey, "abc-123:companion:blueprint-ollama");
    assert.notEqual(companionInput?.idempotencyKey, "abc-123");
  });

  test("omits companion idempotency keys entirely when the caller sent none", async () => {
    const deps = recordingDeps(async (input) => ({
      success: true,
      message: "ok",
      app: summary(1, input.name)
    }));

    await deployTemplateStack(deps, { main: mainInput(), companions: [ollamaCompanion] });

    const companionInput = deps.createInputs.find((i) => i.name === "blueprint-ollama");
    assert.equal(companionInput?.idempotencyKey, undefined);
  });

  test("an empty companion list behaves exactly like a plain single-app create", async () => {
    const deps = recordingDeps(async (input) => ({
      success: true,
      message: "App created successfully.",
      app: summary(1, input.name)
    }));

    const result = await deployTemplateStack(deps, { main: mainInput(), companions: [] });

    assert.equal(result.success, true);
    assert.deepEqual(deps.created, ["blueprint"]);
    assert.deepEqual(result.companions, []);
  });
});

describe("companionIdempotencyKey", () => {
  test("is stable for the same inputs and distinct per companion", () => {
    assert.equal(companionIdempotencyKey("k", "a"), companionIdempotencyKey("k", "a"));
    assert.notEqual(companionIdempotencyKey("k", "a"), companionIdempotencyKey("k", "b"));
  });
});
