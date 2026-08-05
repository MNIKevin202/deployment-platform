import type { AppDatabase } from "../database.js";
import { loadEncryptionKey, encryptSecret, decryptSecret } from "./crypto-service.js";

/**
 * Reads the latest result from a Speedtest Tracker instance
 * (https://docs.speedtest-tracker.dev) so the panel can show the host's
 * real internet speed alongside its other resource figures.
 *
 * The instance is the operator's own app; only its URL and an API token are
 * stored. The token is a secret, so it lives encrypted in the provider
 * credential table exactly like the GitHub PAT — it is never returned by any
 * GET route, and every call to Speedtest Tracker is made server-side (a
 * browser call would be cross-origin blocked anyway, and would expose the
 * token to the client).
 */

export const SPEEDTEST_PROVIDER = "speedtest-tracker";
export const SPEEDTEST_URL_KEY = "speedtest_url";

/** Speedtest Tracker returns 406 unless this is sent. */
const JSON_ACCEPT = "application/json";

export interface SpeedtestReading {
  /** Pre-formatted by Speedtest Tracker, e.g. "241.53 Mbps" — used as-is rather than re-deriving units. */
  downloadHuman: string | null;
  uploadHuman: string | null;
  /** Raw bits per second, for anything that needs to compare numerically. */
  downloadBits: number | null;
  uploadBits: number | null;
  pingMs: number | null;
  jitterMs: number | null;
  packetLoss: number | null;
  isp: string | null;
  serverName: string | null;
  /** Speedtest Tracker's own pass/fail assessment against its configured thresholds. */
  healthy: boolean | null;
  /** ISO timestamp of the test itself. */
  measuredAt: string | null;
  /**
   * True when the most recent test recorded no measurements — Speedtest
   * Tracker still writes a row when a run fails, so without this the panel
   * would show a fresh timestamp next to a grid of "Unknown" and look broken
   * rather than reporting that the test itself failed.
   */
  failed: boolean;
  /** Speedtest Tracker's reason for the failure, when it recorded one. */
  failureMessage: string | null;
}

/**
 * Laravel serialises decimal-cast columns as *strings* ("12.345"), and which
 * columns are decimals has changed between Speedtest Tracker versions — so a
 * numeric string is accepted as readily as a number.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Formats bits per second the way Speedtest Tracker's own `*_human` fields do. */
function humanizeBits(bits: number | null): string | null {
  if (bits === null) {
    return null;
  }
  return `${(bits / 1_000_000).toFixed(2)} Mbps`;
}

/**
 * A failed run stores the reason in `data`, which is sometimes a plain string
 * and sometimes an object — both are unwrapped here so the operator sees the
 * actual error instead of a generic "it didn't work".
 */
function extractFailureMessage(root: Record<string, unknown>, nested: Record<string, unknown>): string | null {
  return (
    asString(root.data) ??
    asString(nested.message) ??
    asString(nested.error) ??
    asString(root.message) ??
    null
  );
}

/**
 * Maps Speedtest Tracker's `/results/latest` payload into the narrow shape
 * the panel shows. Pure and defensive: every field is optional in their
 * schema, and the nested `data` blob varies by speedtest engine, so anything
 * missing or of an unexpected type becomes null rather than throwing or
 * rendering "undefined".
 *
 * Note `/results/latest` returns the result FLAT, unlike `/results/{id}`
 * which wraps it in `data` — both shapes are accepted here so a future
 * change on their side doesn't silently produce an empty card.
 */
export function normalizeSpeedtestResult(payload: unknown): SpeedtestReading | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const outer = payload as Record<string, unknown>;
  // Accept the wrapped shape too (see above).
  const root =
    "download_bits" in outer || "ping" in outer || "created_at" in outer
      ? outer
      : ((outer.data as Record<string, unknown> | undefined) ?? outer);

  const nestedRaw = root.data;
  const nested =
    typeof nestedRaw === "object" && nestedRaw !== null ? (nestedRaw as Record<string, unknown>) : {};
  const nestedPing = (nested.ping as Record<string, unknown> | undefined) ?? {};
  const nestedServer = (nested.server as Record<string, unknown> | undefined) ?? {};

  // `download_bits` is an accessor, not a column, so it is absent whenever the
  // API serialises the bare model. The `download`/`upload` columns hold the
  // raw Ookla bandwidth in BYTES per second, hence the ×8.
  const downloadBits = asNumber(root.download_bits) ?? multiplyBits(asNumber(root.download));
  const uploadBits = asNumber(root.upload_bits) ?? multiplyBits(asNumber(root.upload));

  const measuredAt = asString(root.created_at);
  const pingMs = asNumber(root.ping);

  const explicitlyFailed =
    root.failed === true || (asString(root.status) ?? "").toLowerCase() === "failed";
  const hasMeasurement = downloadBits !== null || uploadBits !== null || pingMs !== null;

  const reading: SpeedtestReading = {
    downloadHuman: asString(root.download_bits_human) ?? humanizeBits(downloadBits),
    uploadHuman: asString(root.upload_bits_human) ?? humanizeBits(uploadBits),
    downloadBits,
    uploadBits,
    pingMs,
    jitterMs: asNumber(nestedPing.jitter),
    packetLoss: asNumber(nested.packetLoss),
    isp: asString(nested.isp),
    serverName: asString(nestedServer.name),
    healthy: typeof root.healthy === "boolean" ? root.healthy : null,
    measuredAt,
    failed: explicitlyFailed || !hasMeasurement,
    failureMessage: null
  };

  if (reading.failed) {
    reading.failureMessage = extractFailureMessage(root, nested);
  }

  // A payload with nothing usable in it is reported as "no reading" rather
  // than an empty card full of dashes.
  const hasAnything = hasMeasurement || measuredAt !== null;

  return hasAnything ? reading : null;
}

function multiplyBits(bytesPerSecond: number | null): number | null {
  return bytesPerSecond === null ? null : bytesPerSecond * 8;
}

export function isValidSpeedtestUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Trims any trailing slash so joining the API path can't produce a double slash. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export type SpeedtestFetch = (
  url: string,
  init: { method?: string; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const defaultFetch: SpeedtestFetch = (url, init) =>
  fetch(url, init) as unknown as ReturnType<SpeedtestFetch>;

export interface SpeedtestDeps {
  appDatabase: AppDatabase;
  fetchImpl?: SpeedtestFetch;
  /** How long to wait on the remote instance before giving up. Default 5s. */
  timeoutMs?: number;
  now?: () => number;
}

export interface SpeedtestConnectionInfo {
  configured: boolean;
  url: string | null;
  lastValidatedAt: string | null;
  /** True when a URL is saved but the encryption key needed to read the token is unavailable. */
  credentialUnreadable: boolean;
}

/** The token-free summary — the only thing any GET route returns about the connection. */
export function getSpeedtestConnectionInfo(appDatabase: AppDatabase): SpeedtestConnectionInfo {
  const url = appDatabase.getSetting(SPEEDTEST_URL_KEY);
  const stored = appDatabase.getProviderCredential(SPEEDTEST_PROVIDER);

  if (!url || !stored) {
    return { configured: false, url: null, lastValidatedAt: null, credentialUnreadable: false };
  }

  return {
    configured: true,
    url,
    lastValidatedAt: stored.lastValidatedAt,
    credentialUnreadable: !loadEncryptionKey().available
  };
}

export interface SpeedtestFetchResult {
  reading: SpeedtestReading | null;
  /** Operator-facing reason the reading is missing. Never contains the token. */
  error: string | null;
}

/**
 * One call to the configured instance. Bounded by a timeout so an
 * unreachable or slow instance can never hang a page load — the same lesson
 * as the Docker usage lookup.
 */
async function fetchLatestOnce(deps: SpeedtestDeps): Promise<SpeedtestFetchResult> {
  const { appDatabase } = deps;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const timeoutMs = deps.timeoutMs ?? 5000;

  const url = appDatabase.getSetting(SPEEDTEST_URL_KEY);
  const stored = appDatabase.getProviderCredential(SPEEDTEST_PROVIDER);

  if (!url || !stored) {
    return { reading: null, error: null };
  }

  const keyStatus = loadEncryptionKey();
  if (!keyStatus.available) {
    return { reading: null, error: "The encryption key needed to read the saved API token is unavailable." };
  }

  let token: string;
  try {
    token = decryptSecret(keyStatus.key, stored.encryptedPayload);
  } catch {
    return { reading: null, error: "The saved API token could not be decrypted. Re-enter it to reconnect." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${normalizeBaseUrl(url)}/api/v1/results/latest`, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Speedtest Tracker answers 406 without this.
        Accept: JSON_ACCEPT
      },
      signal: controller.signal
    });

    if (response.status === 401 || response.status === 403) {
      return {
        reading: null,
        error: "Speedtest Tracker rejected the API token. Check it has the \"Read Results\" ability."
      };
    }
    if (response.status === 404) {
      return { reading: null, error: "No speedtest results yet — run one in Speedtest Tracker." };
    }
    if (!response.ok) {
      return { reading: null, error: `Speedtest Tracker returned HTTP ${response.status}.` };
    }

    return { reading: normalizeSpeedtestResult(await response.json()), error: null };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      reading: null,
      error: aborted
        ? `Speedtest Tracker did not respond within ${timeoutMs}ms.`
        : "Could not reach Speedtest Tracker at the saved URL."
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface SpeedtestProvider {
  getLatest(): Promise<SpeedtestFetchResult>;
  /** Drops any cached reading, so the next call re-fetches (used after the connection changes). */
  invalidate(): void;
}

/**
 * Cached, single-flight wrapper around the fetch above — the reading only
 * changes when a scheduled speedtest runs (typically hourly), so polling the
 * remote instance on every page load would be pure waste. Create one per
 * process so the cache is actually shared.
 */
export function createSpeedtestProvider(
  deps: SpeedtestDeps,
  options: { ttlMs?: number } = {}
): SpeedtestProvider {
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const now = deps.now ?? (() => Date.now());

  let cached: { value: SpeedtestFetchResult; expiresAt: number } | null = null;
  let inFlight: Promise<SpeedtestFetchResult> | null = null;

  return {
    async getLatest() {
      if (cached && cached.expiresAt > now()) {
        return cached.value;
      }
      if (inFlight) {
        return inFlight;
      }

      const attempt = fetchLatestOnce(deps);
      inFlight = attempt;

      try {
        const value = await attempt;
        // Only a successful reading is cached — an error is retried on the
        // next call rather than being pinned for the full TTL.
        if (value.reading) {
          cached = { value, expiresAt: now() + ttlMs };
        }
        return value;
      } finally {
        if (inFlight === attempt) {
          inFlight = null;
        }
      }
    },
    invalidate() {
      cached = null;
    }
  };
}

export interface SaveSpeedtestResult {
  success: boolean;
  statusCode?: number;
  message?: string;
  info?: SpeedtestConnectionInfo;
}

/**
 * Validates the URL + token by actually calling the instance, then stores
 * them. A token that doesn't work is never saved, so a green "connected"
 * state always means a real, verified connection.
 */
export async function saveSpeedtestConnection(
  deps: SpeedtestDeps,
  input: { url: string; token: string }
): Promise<SaveSpeedtestResult> {
  const url = normalizeBaseUrl(input.url);
  const token = input.token.trim();

  if (!isValidSpeedtestUrl(url)) {
    return { success: false, statusCode: 400, message: "Enter a valid http(s) URL for your Speedtest Tracker." };
  }
  if (token.length === 0) {
    return { success: false, statusCode: 400, message: "An API token is required." };
  }

  const keyStatus = loadEncryptionKey();
  if (!keyStatus.available) {
    return {
      success: false,
      statusCode: 503,
      message: "The platform's encryption key is unavailable, so the API token can't be stored securely."
    };
  }

  // Verify before persisting, using the supplied values directly.
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${url}/api/v1/results/latest`, {
      headers: { Authorization: `Bearer ${token}`, Accept: JSON_ACCEPT },
      signal: controller.signal
    });

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        statusCode: 400,
        message: "Speedtest Tracker rejected that token. Make sure it has the \"Read Results\" ability."
      };
    }
    // 404 means "connected, but no results recorded yet" — a legitimate
    // state for a fresh install, so it is accepted rather than refused.
    if (!response.ok && response.status !== 404) {
      return {
        success: false,
        statusCode: 400,
        message: `Speedtest Tracker returned HTTP ${response.status} for that URL and token.`
      };
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      success: false,
      statusCode: 400,
      message: aborted
        ? `That URL did not respond within ${timeoutMs}ms.`
        : "Could not reach a Speedtest Tracker at that URL."
    };
  } finally {
    clearTimeout(timer);
  }

  deps.appDatabase.setSetting(SPEEDTEST_URL_KEY, url);
  deps.appDatabase.upsertProviderCredential({
    provider: SPEEDTEST_PROVIDER,
    encryptedPayload: encryptSecret(keyStatus.key, token),
    authenticatedUsername: null,
    permissionsJson: null,
    lastValidatedAt: new Date((deps.now ?? (() => Date.now()))()).toISOString()
  });

  return { success: true, info: getSpeedtestConnectionInfo(deps.appDatabase) };
}

export function clearSpeedtestConnection(appDatabase: AppDatabase): void {
  appDatabase.deleteSetting(SPEEDTEST_URL_KEY);
  appDatabase.deleteProviderCredential(SPEEDTEST_PROVIDER);
}


export interface RunSpeedtestResult {
  success: boolean;
  statusCode?: number;
  message: string;
}

/**
 * Asks the configured instance to run a test now. Speedtest Tracker queues
 * it and returns 201 immediately — the result appears in a later reading
 * rather than in this response, which is why this reports "started" rather
 * than returning a measurement.
 *
 * Needs a token with the "Run Speedtest" ability; a token that only has
 * "Read Results" gets a 403, reported here as exactly that so the operator
 * knows to re-issue the token rather than wondering why nothing happened.
 */
export async function runSpeedtest(deps: SpeedtestDeps): Promise<RunSpeedtestResult> {
  const { appDatabase } = deps;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  // A speedtest itself takes a while, but the request only queues it, so the
  // usual short budget is right.
  const timeoutMs = deps.timeoutMs ?? 10_000;

  const url = appDatabase.getSetting(SPEEDTEST_URL_KEY);
  const stored = appDatabase.getProviderCredential(SPEEDTEST_PROVIDER);

  if (!url || !stored) {
    return { success: false, statusCode: 400, message: "No Speedtest Tracker is connected." };
  }

  const keyStatus = loadEncryptionKey();
  if (!keyStatus.available) {
    return {
      success: false,
      statusCode: 503,
      message: "The encryption key needed to read the saved API token is unavailable."
    };
  }

  let token: string;
  try {
    token = decryptSecret(keyStatus.key, stored.encryptedPayload);
  } catch {
    return {
      success: false,
      statusCode: 400,
      message: "The saved API token could not be decrypted. Re-enter it to reconnect."
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${normalizeBaseUrl(url)}/api/v1/speedtests/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: JSON_ACCEPT },
      signal: controller.signal
    });

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        statusCode: 400,
        message:
          "Speedtest Tracker refused to start a test. The API token needs the \"Run Speedtest\" ability — the one saved here may only have \"Read Results\"."
      };
    }
    if (!response.ok) {
      return {
        success: false,
        statusCode: 400,
        message: `Speedtest Tracker returned HTTP ${response.status} when starting a test.`
      };
    }

    return {
      success: true,
      message: "Speed test started. It takes a minute or so — the reading updates once it finishes."
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      success: false,
      statusCode: 400,
      message: aborted
        ? `Speedtest Tracker did not respond within ${timeoutMs}ms.`
        : "Could not reach Speedtest Tracker at the saved URL."
    };
  } finally {
    clearTimeout(timer);
  }
}
