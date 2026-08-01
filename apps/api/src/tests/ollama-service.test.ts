import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";
import {
  findLinkedOllamaApp,
  getPullState,
  isBlueprintWebImage,
  isOllamaImage,
  isValidOllamaModelName,
  listOllamaModels,
  parseOllamaHostFromUrl,
  parseOllamaModels,
  parsePullProgressLine,
  resetPullStates,
  startOllamaPull,
  type CompanionAppCandidate
} from "../services/ollama-service.js";

describe("isBlueprintWebImage / isOllamaImage", () => {
  test("match regardless of registry, namespace, and tag", () => {
    assert.equal(isBlueprintWebImage("ghcr.io/open-webui/open-webui:0.11.0"), true);
    assert.equal(isBlueprintWebImage("open-webui"), true);
    assert.equal(isOllamaImage("ollama/ollama:0.32.5"), true);
  });

  test("reject unrelated images", () => {
    assert.equal(isBlueprintWebImage("ollama/ollama:0.32.5"), false);
    assert.equal(isOllamaImage("ghcr.io/open-webui/open-webui:0.11.0"), false);
    assert.equal(isBlueprintWebImage("postgres:16"), false);
  });
});

describe("isValidOllamaModelName", () => {
  test("accepts real Ollama model references", () => {
    for (const model of [
      "llama3.2:1b",
      "llama3.2:3b",
      "qwen3:1.7b",
      "gemma3:4b",
      "phi4-mini",
      "library/mistral:7b"
    ]) {
      assert.equal(isValidOllamaModelName(model), true, `${model} should be valid`);
    }
  });

  test("rejects injection-shaped and malformed input", () => {
    for (const model of [
      "",
      "   ",
      "llama3.2 3b",
      "llama3.2;rm -rf /",
      "../../etc/passwd",
      "model/../../x",
      "http://evil.example/model",
      "model\nname",
      'model"name',
      "model$(id)",
      "-startswithdash",
      "a".repeat(129)
    ]) {
      assert.equal(isValidOllamaModelName(model), false, `${JSON.stringify(model)} should be rejected`);
    }
  });

  test("rejects a non-string without throwing", () => {
    assert.equal(isValidOllamaModelName(undefined as unknown as string), false);
    assert.equal(isValidOllamaModelName(42 as unknown as string), false);
  });
});

describe("parseOllamaModels", () => {
  test("normalizes the documented /api/tags payload", () => {
    const models = parseOllamaModels({
      models: [
        {
          name: "llama3.2:3b",
          model: "llama3.2:3b",
          modified_at: "2026-07-31T10:00:00Z",
          size: 2019393189,
          details: { parameter_size: "3.2B", quantization_level: "Q4_K_M" }
        }
      ]
    });

    assert.equal(models.length, 1);
    assert.equal(models[0].name, "llama3.2:3b");
    assert.equal(models[0].size, 2019393189);
    assert.equal(models[0].parameterSize, "3.2B");
    assert.equal(models[0].quantization, "Q4_K_M");
  });

  test("tolerates missing fields and a missing models array", () => {
    assert.deepEqual(parseOllamaModels({}), []);
    assert.deepEqual(parseOllamaModels(null), []);
    assert.deepEqual(parseOllamaModels({ models: "nope" }), []);

    const partial = parseOllamaModels({ models: [{ name: "x" }, { size: 5 }] });
    assert.equal(partial.length, 1, "entries without a name are dropped");
    assert.equal(partial[0].size, 0);
  });
});

describe("parsePullProgressLine", () => {
  test("reads a status line", () => {
    assert.deepEqual(parsePullProgressLine('{"status":"pulling manifest"}'), {
      detail: "pulling manifest",
      percent: null,
      error: null
    });
  });

  test("computes a percentage from total/completed", () => {
    const progress = parsePullProgressLine(
      '{"status":"pulling abc","total":1000,"completed":250}'
    );
    assert.equal(progress?.percent, 25);
  });

  test("surfaces a stream error", () => {
    const progress = parsePullProgressLine('{"error":"model not found"}');
    assert.equal(progress?.error, "model not found");
  });

  test("ignores blank lines and non-JSON noise", () => {
    assert.equal(parsePullProgressLine(""), null);
    assert.equal(parsePullProgressLine("   "), null);
    assert.equal(parsePullProgressLine("not json"), null);
  });
});

describe("parseOllamaHostFromUrl", () => {
  test("extracts the container name from an internal URL", () => {
    assert.equal(parseOllamaHostFromUrl("http://app-blueprint-ollama:11434"), "app-blueprint-ollama");
    assert.equal(parseOllamaHostFromUrl("http://app-x:11434/"), "app-x");
  });

  test("returns null for anything that isn't a plain host URL", () => {
    assert.equal(parseOllamaHostFromUrl(""), null);
    assert.equal(parseOllamaHostFromUrl("not a url"), null);
    assert.equal(parseOllamaHostFromUrl("http://host/api/pull"), null);
  });
});

describe("findLinkedOllamaApp", () => {
  const apps: CompanionAppCandidate[] = [
    { id: 1, image: "ghcr.io/open-webui/open-webui:0.11.0", containerName: "app-blueprint", containerId: "c1" },
    { id: 2, image: "ollama/ollama:0.32.5", containerName: "app-blueprint-ollama", containerId: "c2" },
    { id: 3, image: "ollama/ollama:0.32.5", containerName: "app-other-ollama", containerId: "c3" }
  ];

  test("resolves the model server the app's own OLLAMA_BASE_URL points at", () => {
    const linked = findLinkedOllamaApp(
      apps,
      () => [{ key: "OLLAMA_BASE_URL", value: "http://app-blueprint-ollama:11434" }],
      1
    );
    assert.equal(linked?.id, 2);
  });

  test("picks the right one when several model servers exist", () => {
    const linked = findLinkedOllamaApp(
      apps,
      () => [{ key: "OLLAMA_BASE_URL", value: "http://app-other-ollama:11434" }],
      1
    );
    assert.equal(linked?.id, 3);
  });

  test("returns null when the env var is missing, unparseable, or unmatched", () => {
    assert.equal(findLinkedOllamaApp(apps, () => [], 1), null);
    assert.equal(
      findLinkedOllamaApp(apps, () => [{ key: "OLLAMA_BASE_URL", value: "garbage" }], 1),
      null
    );
    assert.equal(
      findLinkedOllamaApp(apps, () => [{ key: "OLLAMA_BASE_URL", value: "http://app-gone:11434" }], 1),
      null
    );
  });
});

let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server?.close(resolve));
    server = null;
  }
  resetPullStates();
});

async function startFakeOllama(handler: http.RequestListener): Promise<{ host: string; port: number }> {
  server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server?.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { host: "127.0.0.1", port: address.port };
}

describe("listOllamaModels", () => {
  test("reads the installed model list over HTTP", async () => {
    const { host, port } = await startFakeOllama((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "llama3.2:3b", size: 100 }] }));
    });

    const models = await listOllamaModels(host, port);
    assert.deepEqual(
      models.map((model) => model.name),
      ["llama3.2:3b"]
    );
  });
});

describe("startOllamaPull", () => {
  test("rejects an invalid model name before contacting the server", () => {
    const result = startOllamaPull(1, "127.0.0.1", 1, "bad name; rm -rf /");
    assert.equal(result.started, false);
    assert.equal(result.status, 400);
    assert.equal(getPullState(1), null, "an invalid request records no pull state");
  });

  test("tracks a successful pull to completion", async () => {
    const { host, port } = await startFakeOllama((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.write('{"status":"pulling manifest"}\n');
      response.write('{"status":"downloading","total":100,"completed":50}\n');
      response.end('{"status":"success"}\n');
    });

    const result = startOllamaPull(2, host, port, "llama3.2:1b");
    assert.equal(result.started, true);
    assert.equal(result.status, 202);
    assert.equal(getPullState(2)?.status, "running");

    await waitForPull(2);

    const state = getPullState(2);
    assert.equal(state?.status, "succeeded");
    assert.equal(state?.error, null);
    assert.equal(state?.percent, 50);
  });

  test("refuses a second pull while one is already running", async () => {
    const { host, port } = await startFakeOllama((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.write('{"status":"pulling manifest"}\n');
      // Deliberately left open so the pull stays in-flight.
    });

    const first = startOllamaPull(3, host, port, "llama3.2:1b");
    assert.equal(first.started, true);

    const second = startOllamaPull(3, host, port, "gemma3:4b");
    assert.equal(second.started, false);
    assert.equal(second.status, 409);
    assert.match(second.message, /already running/);
    assert.equal(getPullState(3)?.model, "llama3.2:1b", "the running pull is untouched");
  });

  test("records a stream error as a failure, and allows a retry afterwards", async () => {
    const { host, port } = await startFakeOllama((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.end('{"error":"model \\"nope:1b\\" not found"}\n');
    });

    startOllamaPull(4, host, port, "nope:1b");
    await waitForPull(4);

    const failed = getPullState(4);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /not found/);

    // A finished pull — successful or failed — must never block the next one.
    const retry = startOllamaPull(4, host, port, "nope:1b");
    assert.equal(retry.started, true, "a failed pull can be retried");
  });

  test("records an HTTP error from the model server as a failure", async () => {
    const { host, port } = await startFakeOllama((_request, response) => {
      response.writeHead(500);
      response.end("boom");
    });

    startOllamaPull(5, host, port, "llama3.2:1b");
    await waitForPull(5);

    assert.equal(getPullState(5)?.status, "failed");
  });

  test("tracks pulls per app, so one app's download never blocks another's", async () => {
    const { host, port } = await startFakeOllama((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.write('{"status":"pulling manifest"}\n');
    });

    assert.equal(startOllamaPull(10, host, port, "llama3.2:1b").started, true);
    assert.equal(startOllamaPull(11, host, port, "llama3.2:1b").started, true);
  });
});

/** Waits for a tracked pull to leave the "running" state. */
async function waitForPull(appId: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (getPullState(appId)?.status !== "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`pull for app ${appId} did not finish within ${timeoutMs}ms`);
}
