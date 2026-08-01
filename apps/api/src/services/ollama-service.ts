/**
 * Thin HTTP client for a Blueprint app's private Ollama model server, plus
 * the pull-tracking that makes model downloads safe to drive from a web UI.
 *
 * The model server is an ordinary managed app with no public domain and no
 * published port, so the only way to reach it is what this module does:
 * a plain fetch() by its container name over the deployment-apps Docker
 * network that deployment-platform-api is itself attached to — the same
 * approach irc-bot-admin-service.ts uses for the IRC bot's admin API.
 *
 * Endpoints and payload shapes below follow Ollama's documented API
 * (GET /api/tags, POST /api/pull, DELETE /api/delete, GET /api/version).
 */

/** Short calls (listing, version, delete) — the server answers immediately. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Pulls are deliberately NOT bounded by a short timeout: a multi-gigabyte
 * download on a small VPS legitimately takes many minutes. This is only a
 * backstop against a pull that has genuinely wedged, so the slot can be
 * reclaimed and retried.
 */
const PULL_TIMEOUT_MS = 60 * 60 * 1000;

export class OllamaUnreachableError extends Error {}

/** Whether an image is Blueprint's chat interface, for showing its tab. */
export function isBlueprintWebImage(image: string): boolean {
  return imageRepoName(image) === "open-webui";
}

/** Whether an image is the Ollama model server. */
export function isOllamaImage(image: string): boolean {
  return imageRepoName(image) === "ollama";
}

function imageRepoName(image: string): string {
  let ref = image.trim();

  const at = ref.indexOf("@");
  if (at >= 0) {
    ref = ref.slice(0, at);
  }

  const lastSlash = ref.lastIndexOf("/");
  let name = lastSlash >= 0 ? ref.slice(lastSlash + 1) : ref;

  const colon = name.indexOf(":");
  if (colon >= 0) {
    name = name.slice(0, colon);
  }

  return name.toLowerCase();
}

/**
 * Ollama model references look like `llama3.2:3b`, `qwen3`, or
 * `library/gemma3:4b`. This is deliberately strict rather than clever: the
 * value arrives from the browser and is placed in a JSON body sent to an
 * internal service, so anything outside this charset — whitespace, quotes,
 * shell metacharacters, path traversal, a URL — is rejected outright rather
 * than escaped and hoped about.
 */
const MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?(:[a-z0-9][a-z0-9._-]*)?$/i;

const MAX_MODEL_NAME_LENGTH = 128;

export function isValidOllamaModelName(model: string): boolean {
  if (typeof model !== "string") {
    return false;
  }

  const trimmed = model.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_MODEL_NAME_LENGTH) {
    return false;
  }

  // Two dots in a row can only be a traversal attempt — no real tag uses it.
  if (trimmed.includes("..")) {
    return false;
  }

  return MODEL_NAME_PATTERN.test(trimmed);
}

export interface OllamaModel {
  name: string;
  /** Size on disk in bytes. */
  size: number;
  modifiedAt: string | null;
  parameterSize: string | null;
  quantization: string | null;
}

function ollamaUrl(containerName: string, containerPort: number, path: string): string {
  return `http://${containerName}:${containerPort}${path}`;
}

async function ollamaFetch(
  containerName: string,
  containerPort: number,
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(ollamaUrl(containerName, containerPort, path), {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    throw new OllamaUnreachableError(
      `Unable to reach the model server: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    clearTimeout(timer);
  }
}

/** The model server's version, or null when it isn't answering yet. */
export async function getOllamaVersion(
  containerName: string,
  containerPort: number
): Promise<string | null> {
  try {
    const response = await ollamaFetch(
      containerName,
      containerPort,
      "/api/version",
      undefined,
      REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

interface RawOllamaModel {
  name?: string;
  model?: string;
  size?: number;
  modified_at?: string;
  details?: { parameter_size?: string; quantization_level?: string };
}

/** Normalizes Ollama's /api/tags payload into the shape the panel renders. */
export function parseOllamaModels(body: unknown): OllamaModel[] {
  const models = (body as { models?: RawOllamaModel[] } | null)?.models;

  if (!Array.isArray(models)) {
    return [];
  }

  return models
    .map((entry) => ({
      name: entry.name ?? entry.model ?? "",
      size: typeof entry.size === "number" ? entry.size : 0,
      modifiedAt: entry.modified_at ?? null,
      parameterSize: entry.details?.parameter_size ?? null,
      quantization: entry.details?.quantization_level ?? null
    }))
    .filter((model) => model.name.length > 0);
}

export async function listOllamaModels(
  containerName: string,
  containerPort: number
): Promise<OllamaModel[]> {
  const response = await ollamaFetch(
    containerName,
    containerPort,
    "/api/tags",
    undefined,
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new OllamaUnreachableError(`Model server returned ${response.status}`);
  }

  return parseOllamaModels(await response.json());
}

export async function deleteOllamaModel(
  containerName: string,
  containerPort: number,
  model: string
): Promise<{ ok: boolean; status: number; message: string }> {
  const response = await ollamaFetch(
    containerName,
    containerPort,
    "/api/delete",
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model })
    },
    REQUEST_TIMEOUT_MS
  );

  if (response.status === 404) {
    return { ok: false, status: 404, message: `Model "${model}" is not installed.` };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      message: `The model server refused to delete "${model}" (HTTP ${response.status}).`
    };
  }

  return { ok: true, status: 200, message: `Model "${model}" was deleted.` };
}

export type PullStatus = "running" | "succeeded" | "failed";

export interface PullState {
  model: string;
  status: PullStatus;
  /** Latest human-readable progress line from Ollama's stream. */
  detail: string;
  /** 0–100 when the stream reports byte counts, else null. */
  percent: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/**
 * Live pull state, keyed by app id. Deliberately in-memory (like
 * image-update-check-service's cache) rather than a schema change: a pull
 * is a transient runtime activity, and after an API restart the truthful
 * answer is simply "no pull is running", which is exactly what an empty map
 * reports. The installed-models list — the durable fact — always comes from
 * Ollama itself.
 */
const pullStates = new Map<number, PullState>();

export function getPullState(appId: number): PullState | null {
  return pullStates.get(appId) ?? null;
}

/** Test seam: clears tracked pulls. */
export function resetPullStates(): void {
  pullStates.clear();
}

export interface StartPullResult {
  started: boolean;
  status: number;
  message: string;
  state: PullState | null;
}

/**
 * Parses one line of Ollama's newline-delimited pull stream into a progress
 * update. Returns null for a line that carries nothing worth showing.
 */
export function parsePullProgressLine(
  line: string
): { detail: string; percent: number | null; error: string | null } | null {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  let parsed: { status?: string; error?: string; total?: number; completed?: number };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (parsed.error) {
    return { detail: parsed.error, percent: null, error: parsed.error };
  }

  const percent =
    typeof parsed.total === "number" &&
    parsed.total > 0 &&
    typeof parsed.completed === "number"
      ? Math.min(100, Math.round((parsed.completed / parsed.total) * 100))
      : null;

  return { detail: parsed.status ?? "", percent, error: null };
}

/**
 * Starts a model download and tracks its progress, returning as soon as the
 * download is under way rather than waiting for it to finish — a multi-GB
 * pull far outlives an HTTP request from the browser.
 *
 * Only one pull runs per app at a time: a second request while one is
 * running is refused (409) instead of starting a duplicate download of the
 * same weights. A finished pull — successful or failed — leaves its state
 * behind so the panel can show the outcome, and never blocks a retry.
 */
export function startOllamaPull(
  appId: number,
  containerName: string,
  containerPort: number,
  model: string,
  onLog?: (line: string) => void
): StartPullResult {
  if (!isValidOllamaModelName(model)) {
    return {
      started: false,
      status: 400,
      message: `"${model}" is not a valid model name.`,
      state: null
    };
  }

  const existing = pullStates.get(appId);

  if (existing && existing.status === "running") {
    return {
      started: false,
      status: 409,
      message: `A download of "${existing.model}" is already running. Wait for it to finish before starting another.`,
      state: existing
    };
  }

  const state: PullState = {
    model,
    status: "running",
    detail: "Starting download…",
    percent: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null
  };

  pullStates.set(appId, state);

  const finish = (status: PullStatus, error: string | null, detail: string) => {
    const current = pullStates.get(appId);

    // Only finalize the pull this call started — a later pull for the same
    // app must not have its state overwritten by a straggling earlier one.
    if (!current || current.startedAt !== state.startedAt) {
      return;
    }

    current.status = status;
    current.error = error;
    current.detail = detail;
    current.finishedAt = new Date().toISOString();
  };

  void (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);

    try {
      const response = await fetch(
        ollamaUrl(containerName, containerPort, "/api/pull"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
          signal: controller.signal
        }
      );

      if (!response.ok || !response.body) {
        finish(
          "failed",
          `The model server returned HTTP ${response.status}.`,
          "Download failed."
        );
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: string | null = null;

      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const progress = parsePullProgressLine(line);

          if (!progress) {
            continue;
          }

          if (progress.error) {
            streamError = progress.error;
          }

          const current = pullStates.get(appId);
          if (current && current.startedAt === state.startedAt) {
            current.detail = progress.detail || current.detail;
            current.percent = progress.percent ?? current.percent;
          }

          if (progress.detail) {
            onLog?.(`[blueprint] pull ${model}: ${progress.detail}`);
          }
        }
      }

      if (streamError) {
        finish("failed", streamError, "Download failed.");
      } else {
        finish("succeeded", null, `"${model}" is ready to use.`);
      }
    } catch (error) {
      finish(
        "failed",
        error instanceof Error ? error.message : String(error),
        "Download failed."
      );
    } finally {
      clearTimeout(timer);
    }
  })();

  return {
    started: true,
    status: 202,
    message: `Downloading "${model}". This can take several minutes.`,
    state
  };
}

export interface CompanionAppCandidate {
  id: number;
  image: string;
  containerName: string | null;
  containerId: string | null;
}

export interface EnvVarLookup {
  key: string;
  value: string;
}

/**
 * Extracts the container name from a Blueprint app's OLLAMA_BASE_URL — the
 * same env var the app itself uses to reach its model server, so the panel
 * can never disagree with what the running app is actually talking to.
 * Returns null for anything that isn't a plain internal http URL.
 */
export function parseOllamaHostFromUrl(url: string): string | null {
  const match = /^https?:\/\/([A-Za-z0-9_.-]+)(?::\d+)?\/?$/.exec(url.trim());
  return match ? match[1] : null;
}

/**
 * Finds the model-server app a Blueprint app points at. There is no formal
 * link between the two app records — the main app's own OLLAMA_BASE_URL is
 * the authoritative signal, matching how findLinkedBotApp resolves the IRC
 * bot from its IRC_HOST.
 */
export function findLinkedOllamaApp(
  apps: CompanionAppCandidate[],
  envVarsByAppId: (appId: number) => EnvVarLookup[],
  blueprintAppId: number
): CompanionAppCandidate | null {
  const baseUrl = envVarsByAppId(blueprintAppId).find(
    (envVar) => envVar.key === "OLLAMA_BASE_URL"
  );

  if (!baseUrl) {
    return null;
  }

  const host = parseOllamaHostFromUrl(baseUrl.value);

  if (!host) {
    return null;
  }

  return apps.find((app) => app.containerName === host) ?? null;
}
