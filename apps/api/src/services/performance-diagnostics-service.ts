import { request as httpRequestFn } from "node:http";
import { request as httpsRequestFn } from "node:https";
import { performance } from "node:perf_hooks";

/**
 * Centralized, easy-to-change latency classifications (section 7 of the
 * spec). Never treated as universal guarantees — only used to color the
 * UI and to help phrase the plain-language diagnosis.
 */
export const PERFORMANCE_THRESHOLDS_MS = {
  internalTotal: { good: 150, moderate: 500 },
  publicTtfb: { good: 250, moderate: 800 },
  browserTtfb: { good: 400, moderate: 1000 },
  pageLoad: { good: 2000, moderate: 4000 }
} as const;

export type LatencyTier = "good" | "moderate" | "slow" | "unknown";

export function classifyLatency(valueMs: number | null, thresholds: { good: number; moderate: number }): LatencyTier {
  if (valueMs === null || !Number.isFinite(valueMs) || valueMs < 0) {
    return "unknown";
  }
  if (valueMs <= thresholds.good) return "good";
  if (valueMs <= thresholds.moderate) return "moderate";
  return "slow";
}

// ============================================================
// Low-level, injectable HTTP probe client — the one DI seam real
// callers use node:http/node:https through, and tests replace with a
// fake that returns canned timings/errors. No real network or Docker
// access is ever required to exercise probePublicRoute/
// probeInternalContainer in tests.
// ============================================================

export interface DetailedHttpProbeResult {
  statusCode: number;
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  totalMs: number;
  responseBytes: number;
  /** Only ever read for a redirect Location header — never stored. */
  location: string | null;
}

export interface DetailedHttpProbeOptions {
  hostname: string;
  port: number;
  protocol: "http" | "https";
  path: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface DetailedHttpProbeClient {
  request(options: DetailedHttpProbeOptions): Promise<DetailedHttpProbeResult>;
}

/**
 * Real implementation — a single, unstreamed GET, with phase timings
 * captured from the underlying socket's own lifecycle events (never
 * approximated or guessed). Response bytes are capped and the
 * connection is destroyed once the cap is hit; body content is never
 * buffered beyond the byte count, never returned, never stored.
 * Never follows redirects itself — that policy decision (same-host
 * only, bounded count) belongs to the caller, not this low-level probe.
 */
export function createRealHttpProbeClient(): DetailedHttpProbeClient {
  return {
    request(options) {
      return new Promise((resolve, reject) => {
        const start = performance.now();
        let dnsEnd: number | null = null;
        let connectEnd: number | null = null;
        let tlsEnd: number | null = null;
        let settled = false;

        const requestFn = options.protocol === "https" ? httpsRequestFn : httpRequestFn;

        const req = requestFn(
          {
            hostname: options.hostname,
            port: options.port,
            path: options.path,
            method: "GET",
            timeout: options.timeoutMs,
            headers: { "User-Agent": "deployment-platform-performance-probe" }
          },
          (res) => {
            const ttfbAt = performance.now();
            let bytes = 0;

            res.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes >= options.maxResponseBytes) {
                res.destroy();
              }
            });

            const finish = () => {
              if (settled) return;
              settled = true;
              resolve({
                statusCode: res.statusCode ?? 0,
                dnsMs: dnsEnd !== null ? dnsEnd - start : null,
                connectMs: connectEnd !== null ? connectEnd - start : null,
                tlsMs: tlsEnd !== null && connectEnd !== null ? tlsEnd - connectEnd : null,
                ttfbMs: ttfbAt - start,
                totalMs: performance.now() - start,
                responseBytes: bytes,
                location:
                  typeof res.headers.location === "string" ? res.headers.location.slice(0, 2048) : null
              });
            };

            res.on("end", finish);
            res.on("close", finish);
            res.on("error", finish);
          }
        );

        req.on("socket", (socket) => {
          socket.on("lookup", () => {
            dnsEnd = performance.now();
          });
          socket.on("connect", () => {
            connectEnd = performance.now();
          });
          socket.on("secureConnect", () => {
            tlsEnd = performance.now();
          });
        });

        req.on("timeout", () => {
          if (settled) return;
          settled = true;
          req.destroy();
          reject(new Error("Request timed out"));
        });

        req.on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });

        req.end();
      });
    }
  };
}

const MAX_PROBE_RESPONSE_BYTES = 256 * 1024;

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function sanitizeProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  // Node's own error messages already avoid embedding request bodies or
  // headers, but strip anything that looks like it might carry a token
  // anyway, consistent with the rest of this codebase's sanitizers.
  return message.replace(/token|authorization|password|secret|credential/gi, "[redacted]").slice(0, 300);
}

// ============================================================
// Public-route probe — the app's own platform-managed domain only.
// ============================================================

export interface PublicProbeResult {
  ok: boolean;
  totalMs: number | null;
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  statusCode: number | null;
  responseBytes: number | null;
  redirectCount: number;
  /** Sanitized — hostname only, never a full URL with path/query. */
  finalHost: string | null;
  error: string | null;
}

export interface ProbePublicRouteOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
}

const DEFAULT_PUBLIC_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * `domain` must always be the app's own platform-managed domain
 * (`app.domain` from the database) — this function never accepts a
 * browser- or operator-supplied URL, and it only ever follows a
 * redirect whose target host exactly matches the host it started
 * with; a redirect to any other host is reported as an error rather
 * than followed, closing the obvious SSRF/open-redirect path a naive
 * "just follow Location" implementation would have.
 */
export async function probePublicRoute(
  client: DetailedHttpProbeClient,
  domain: string,
  options: ProbePublicRouteOptions = {}
): Promise<PublicProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLIC_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_PROBE_RESPONSE_BYTES;

  let currentHost = domain;
  let currentPath = "/";
  let redirectCount = 0;
  const overallStart = performance.now();

  for (;;) {
    let result: DetailedHttpProbeResult;

    try {
      result = await client.request({
        hostname: currentHost,
        port: 443,
        protocol: "https",
        path: currentPath,
        timeoutMs,
        maxResponseBytes
      });
    } catch (error) {
      return {
        ok: false,
        totalMs: round(performance.now() - overallStart),
        dnsMs: null,
        connectMs: null,
        tlsMs: null,
        ttfbMs: null,
        downloadMs: null,
        statusCode: null,
        responseBytes: null,
        redirectCount,
        finalHost: currentHost,
        error: sanitizeProbeError(error)
      };
    }

    if (result.statusCode >= 300 && result.statusCode < 400 && result.location) {
      if (redirectCount >= maxRedirects) {
        return {
          ok: false,
          totalMs: round(performance.now() - overallStart),
          dnsMs: result.dnsMs,
          connectMs: result.connectMs,
          tlsMs: result.tlsMs,
          ttfbMs: result.ttfbMs,
          downloadMs: null,
          statusCode: result.statusCode,
          responseBytes: result.responseBytes,
          redirectCount,
          finalHost: currentHost,
          error: "Too many redirects"
        };
      }

      let target: URL;
      try {
        target = new URL(result.location, `https://${currentHost}${currentPath}`);
      } catch {
        return {
          ok: false,
          totalMs: round(performance.now() - overallStart),
          dnsMs: null,
          connectMs: null,
          tlsMs: null,
          ttfbMs: null,
          downloadMs: null,
          statusCode: result.statusCode,
          responseBytes: null,
          redirectCount,
          finalHost: currentHost,
          error: "Redirect target could not be parsed"
        };
      }

      if (target.hostname !== currentHost) {
        return {
          ok: false,
          totalMs: round(performance.now() - overallStart),
          dnsMs: null,
          connectMs: null,
          tlsMs: null,
          ttfbMs: null,
          downloadMs: null,
          statusCode: result.statusCode,
          responseBytes: null,
          redirectCount,
          finalHost: currentHost,
          error: "Redirect to an untrusted host was blocked"
        };
      }

      redirectCount += 1;
      currentHost = target.hostname;
      currentPath = `${target.pathname}${target.search}`;
      continue;
    }

    return {
      ok: result.statusCode > 0 && result.statusCode < 500,
      totalMs: round(result.totalMs),
      dnsMs: round(result.dnsMs),
      connectMs: round(result.connectMs),
      tlsMs: round(result.tlsMs),
      ttfbMs: round(result.ttfbMs),
      downloadMs: result.ttfbMs !== null ? round(result.totalMs - result.ttfbMs) : null,
      statusCode: result.statusCode,
      responseBytes: result.responseBytes,
      redirectCount,
      finalHost: currentHost,
      error: result.statusCode >= 500 ? `Public route returned HTTP ${result.statusCode}` : null
    };
  }
}

// ============================================================
// Internal-container probe — the managed Docker network only.
// ============================================================

export interface InternalProbeResult {
  ok: boolean;
  totalMs: number | null;
  connectMs: number | null;
  ttfbMs: number | null;
  statusCode: number | null;
  responseBytes: number | null;
  error: string | null;
}

/**
 * `containerName`/`port` must always come from the app's own database
 * row (StoredApp.containerName/containerPort) — never from the
 * browser. No redirects are followed here at all (an internal service
 * redirecting is itself unusual and not part of what this probe is
 * trying to measure).
 */
export async function probeInternalContainer(
  client: DetailedHttpProbeClient,
  containerName: string,
  port: number,
  timeoutMs = 5000
): Promise<InternalProbeResult> {
  try {
    const result = await client.request({
      hostname: containerName,
      port,
      protocol: "http",
      path: "/",
      timeoutMs,
      maxResponseBytes: MAX_PROBE_RESPONSE_BYTES
    });

    return {
      ok: true,
      totalMs: round(result.totalMs),
      connectMs: round(result.connectMs),
      ttfbMs: round(result.ttfbMs),
      statusCode: result.statusCode,
      responseBytes: result.responseBytes,
      error: null
    };
  } catch (error) {
    const sanitized = sanitizeProbeError(error);
    return {
      ok: false,
      totalMs: null,
      connectMs: null,
      ttfbMs: null,
      statusCode: null,
      responseBytes: null,
      error: /timed out/i.test(sanitized) ? "Internal container probe timed out." : sanitized
    };
  }
}

// ============================================================
// Diagnosis — plain-language, never claimed as certain.
// ============================================================

export type DiagnosisCategory =
  | "browser-network"
  | "public-route"
  | "internal-application"
  | "frontend-resources"
  | "server-response"
  | "third-party-resources"
  | "inconclusive";

export interface DiagnosisInput {
  browser: {
    available: boolean;
    ttfbMs: number | null;
    totalLoadMs: number | null;
    dnsMs: number | null;
    tlsMs: number | null;
  } | null;
  publicProbe: PublicProbeResult;
  internalProbe: InternalProbeResult;
  slowestThirdPartyMs: number | null;
  slowestFirstPartyResourceMs: number | null;
}

export interface DiagnosisResult {
  category: DiagnosisCategory;
  message: string;
  evidence: string[];
}

/**
 * Pure comparison logic — never claims certainty; every message is
 * phrased with "likely"/"appears to be"/"may be contributing"/
 * "inconclusive", matching the spec's required tone exactly.
 */
export function diagnosePerformance(input: DiagnosisInput): DiagnosisResult {
  const evidence: string[] = [];

  const internalSlow =
    classifyLatency(input.internalProbe.totalMs, PERFORMANCE_THRESHOLDS_MS.internalTotal) === "slow";
  const publicTtfbSlow =
    classifyLatency(input.publicProbe.ttfbMs, PERFORMANCE_THRESHOLDS_MS.publicTtfb) === "slow";
  const browserTtfbSlow = input.browser
    ? classifyLatency(input.browser.ttfbMs, PERFORMANCE_THRESHOLDS_MS.browserTtfb) === "slow"
    : false;
  const pageLoadSlow = input.browser
    ? classifyLatency(input.browser.totalLoadMs, PERFORMANCE_THRESHOLDS_MS.pageLoad) === "slow"
    : false;

  if (!input.internalProbe.ok) {
    return {
      category: "internal-application",
      message: "The internal container probe failed, so the application itself is likely unreachable or unresponsive on its configured port.",
      evidence: [input.internalProbe.error ?? "Internal probe did not complete."]
    };
  }

  if (!input.publicProbe.ok && input.internalProbe.ok) {
    evidence.push(`Internal response: ${input.internalProbe.totalMs ?? "unknown"} ms.`);
    evidence.push(input.publicProbe.error ?? `Public route status: ${input.publicProbe.statusCode ?? "unknown"}.`);
    return {
      category: "public-route",
      message: "The internal container responded, but the public route did not return a healthy response. This appears to be a Caddy, TLS, DNS, or proxy issue rather than the application itself.",
      evidence
    };
  }

  if (internalSlow) {
    evidence.push(`Internal container total response time: ${input.internalProbe.totalMs} ms (slow).`);
    return {
      category: "internal-application",
      message: "The internal container response is slow. The delay likely originates inside the application, its database, or another backend dependency rather than the network or proxy.",
      evidence
    };
  }

  if (!publicTtfbSlow && !internalSlow && input.browser?.available && browserTtfbSlow) {
    evidence.push(`Server-side public/internal probes were fast (public TTFB ${input.publicProbe.ttfbMs} ms), but the browser measured a TTFB of ${input.browser.ttfbMs} ms.`);
    return {
      category: "browser-network",
      message: "Browser latency is high, but server-side public and internal probes are fast. Geographic distance or client-side network routing may be contributing.",
      evidence
    };
  }

  if (publicTtfbSlow && !internalSlow) {
    evidence.push(`Internal response was fast, but the public route's time to first byte was ${input.publicProbe.ttfbMs} ms.`);
    return {
      category: "public-route",
      message: "Internal container response is fast, but the public route is slow. This appears to point at Caddy, TLS negotiation, DNS, or proxy configuration rather than the application.",
      evidence
    };
  }

  if (input.browser?.available && pageLoadSlow && !browserTtfbSlow) {
    if (input.slowestThirdPartyMs !== null && (input.slowestFirstPartyResourceMs === null || input.slowestThirdPartyMs > input.slowestFirstPartyResourceMs)) {
      evidence.push(`Initial HTML responded quickly, but page load completion took ${input.browser.totalLoadMs} ms. The slowest resource was a third-party asset (${input.slowestThirdPartyMs} ms).`);
      return {
        category: "third-party-resources",
        message: "Initial HTML is fast, but a third-party resource appears to be the slowest part of page completion. Fonts or other externally-hosted assets may be contributing.",
        evidence
      };
    }

    evidence.push(`Initial HTML responded quickly, but page load completion took ${input.browser.totalLoadMs} ms.`);
    return {
      category: "frontend-resources",
      message: "Initial HTML is fast, but the page takes longer to finish loading. Frontend assets (JavaScript, CSS, images, or fonts) appear to be delaying rendering.",
      evidence
    };
  }

  if (!input.browser || !input.browser.available) {
    return {
      category: "inconclusive",
      message: "Results are inconclusive because browser timing data was unavailable.",
      evidence: ["Browser timing API did not return usable data — this can happen due to cross-origin resource timing restrictions."]
    };
  }

  return {
    category: "inconclusive",
    message: "No single stage stood out as the likely bottleneck based on the measured thresholds. Run the test again or compare from another network for a clearer signal.",
    evidence
  };
}

// ============================================================
// Browser-submitted resource sanitization — this is the one place
// operator-browser-supplied data enters the system, so it is never
// trusted as-is: every URL is parsed, stripped of query string/hash,
// capped in length, and classified from a fixed vocabulary. Anything
// that fails to parse as a URL is dropped rather than stored raw.
// ============================================================

export type ResourceCategory = "javascript" | "css" | "image" | "font" | "api" | "other";

export interface SanitizedResourceEntry {
  category: ResourceCategory;
  /** hostname + pathname only — no query string, no hash, no auth. */
  host: string;
  path: string;
  firstParty: boolean;
  startMs: number;
  durationMs: number;
  transferBytes: number | null;
  statusOk: boolean;
}

const MAX_PATH_LENGTH = 200;

// Exact-match only — deliberately not a suffix/substring check, so a
// hostname like "fonts.googleapis.com.attacker.example" (where the real,
// parsed hostname is the attacker's own domain) can never be mistaken
// for the real Google Fonts host. `parsed.hostname` always comes from
// the URL parser, never from raw string matching against the full URL.
const FONT_PROVIDER_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

const FONT_EXTENSION_PATTERN = /\.(woff2?|ttf|otf|eot)$/;

/**
 * Category precedence (deliberately in this order — a Google Fonts
 * stylesheet request from fonts.googleapis.com must be reported as
 * font-loading overhead, not generic CSS, even though the browser's own
 * `initiatorType` for that request is typically "link" or "css"):
 *   1. known font-provider host
 *   2. font file extension
 *   3. explicit "font" initiator type
 *   4. JavaScript
 *   5. CSS
 *   6. image
 *   7. API/fetch/XHR
 *   8. other
 */
function classifyResourceCategory(initiatorType: string, hostname: string, path: string): ResourceCategory {
  const lowerPath = path.toLowerCase();

  if (FONT_PROVIDER_HOSTS.has(hostname)) {
    return "font";
  }
  if (FONT_EXTENSION_PATTERN.test(lowerPath)) {
    return "font";
  }
  if (initiatorType === "font") {
    return "font";
  }
  if (initiatorType === "script" || /\.m?js$/.test(lowerPath)) {
    return "javascript";
  }
  if (initiatorType === "css" || initiatorType === "link" || lowerPath.endsWith(".css")) {
    return "css";
  }
  if (initiatorType === "img" || /\.(png|jpe?g|gif|webp|svg|avif|ico)$/.test(lowerPath)) {
    return "image";
  }
  if (initiatorType === "xmlhttprequest" || initiatorType === "fetch" || lowerPath.includes("/api/")) {
    return "api";
  }
  return "other";
}

export interface RawResourceEntry {
  url: string;
  initiatorType: string;
  startMs: number;
  durationMs: number;
  transferBytes: number | null;
  statusOk: boolean;
}

/**
 * `appDomain` is the app's own platform-managed domain (from the
 * database, never browser-supplied) — used only to decide first-party
 * vs. third-party, never as a trust boundary for what URL was probed
 * (this function never makes a network request itself).
 */
export function sanitizeResourceEntry(raw: RawResourceEntry, appDomain: string): SanitizedResourceEntry | null {
  if (!Number.isFinite(raw.startMs) || !Number.isFinite(raw.durationMs)) {
    return null;
  }
  if (raw.startMs < 0 || raw.durationMs < 0 || raw.durationMs > 5 * 60 * 1000) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const path = parsed.pathname.slice(0, MAX_PATH_LENGTH);
  const transferBytes =
    raw.transferBytes !== null && Number.isFinite(raw.transferBytes) && raw.transferBytes >= 0
      ? Math.min(raw.transferBytes, 1024 * 1024 * 1024)
      : null;

  return {
    category: classifyResourceCategory(raw.initiatorType, parsed.hostname, path),
    host: parsed.hostname,
    path,
    firstParty: parsed.hostname === appDomain,
    startMs: Math.round(raw.startMs),
    durationMs: Math.round(raw.durationMs),
    transferBytes,
    statusOk: raw.statusOk
  };
}

export interface ResourceCategorySummary {
  category: ResourceCategory;
  count: number;
  totalTransferBytes: number;
  totalDurationMs: number;
  slowestPath: string | null;
  slowestDurationMs: number;
  failedCount: number;
}

export function summarizeResourcesByCategory(entries: SanitizedResourceEntry[]): ResourceCategorySummary[] {
  const byCategory = new Map<ResourceCategory, ResourceCategorySummary>();

  for (const entry of entries) {
    const existing = byCategory.get(entry.category) ?? {
      category: entry.category,
      count: 0,
      totalTransferBytes: 0,
      totalDurationMs: 0,
      slowestPath: null,
      slowestDurationMs: 0,
      failedCount: 0
    };

    existing.count += 1;
    existing.totalTransferBytes += entry.transferBytes ?? 0;
    existing.totalDurationMs += entry.durationMs;
    if (entry.durationMs > existing.slowestDurationMs) {
      existing.slowestDurationMs = entry.durationMs;
      existing.slowestPath = `${entry.host}${entry.path}`;
    }
    if (!entry.statusOk) {
      existing.failedCount += 1;
    }

    byCategory.set(entry.category, existing);
  }

  return Array.from(byCategory.values());
}

export const MAX_SUBMITTED_RESOURCES = 200;
export const TOP_SLOWEST_RESOURCES_COUNT = 10;

/** Top N slowest, sorted descending — the compact "waterfall-like" table (section 8), never a full DevTools clone. */
export function topSlowestResources(entries: SanitizedResourceEntry[], count = TOP_SLOWEST_RESOURCES_COUNT): SanitizedResourceEntry[] {
  return [...entries].sort((a, b) => b.durationMs - a.durationMs).slice(0, count);
}
