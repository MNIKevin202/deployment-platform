import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyLatency,
  diagnosePerformance,
  probeInternalContainer,
  probePublicRoute,
  sanitizeResourceEntry,
  summarizeResourcesByCategory,
  topSlowestResources,
  type DetailedHttpProbeClient,
  type DetailedHttpProbeResult,
  type InternalProbeResult,
  type PublicProbeResult
} from "../services/performance-diagnostics-service.js";

function fakeClient(
  handler: (hostname: string, path: string) => DetailedHttpProbeResult | Promise<never>
): DetailedHttpProbeClient {
  return {
    async request(options) {
      const result = handler(options.hostname, options.path);
      if (result instanceof Promise) {
        return result;
      }
      return result;
    }
  };
}

function okResult(overrides: Partial<DetailedHttpProbeResult> = {}): DetailedHttpProbeResult {
  return {
    statusCode: 200,
    dnsMs: 10,
    connectMs: 20,
    tlsMs: 15,
    ttfbMs: 100,
    totalMs: 150,
    responseBytes: 1024,
    location: null,
    ...overrides
  };
}

describe("classifyLatency", () => {
  test("classifies within good/moderate/slow bands", () => {
    assert.equal(classifyLatency(100, { good: 150, moderate: 500 }), "good");
    assert.equal(classifyLatency(300, { good: 150, moderate: 500 }), "moderate");
    assert.equal(classifyLatency(900, { good: 150, moderate: 500 }), "slow");
  });

  test("treats null/NaN/negative as unknown rather than a false classification", () => {
    assert.equal(classifyLatency(null, { good: 150, moderate: 500 }), "unknown");
    assert.equal(classifyLatency(Number.NaN, { good: 150, moderate: 500 }), "unknown");
    assert.equal(classifyLatency(-5, { good: 150, moderate: 500 }), "unknown");
  });
});

describe("probeInternalContainer", () => {
  test("succeeds and reports timings from the injected client", async () => {
    const client = fakeClient(() => okResult({ totalMs: 42, ttfbMs: 30, connectMs: 5 }));
    const result = await probeInternalContainer(client, "app-mflabs", 53123);
    assert.equal(result.ok, true);
    assert.equal(result.totalMs, 42);
    assert.equal(result.ttfbMs, 30);
    assert.equal(result.statusCode, 200);
  });

  test("reports a timeout distinctly, without a stack trace", async () => {
    const client: DetailedHttpProbeClient = {
      async request() {
        throw new Error("Request timed out");
      }
    };
    const result = await probeInternalContainer(client, "app-mflabs", 80);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /timed out/i);
    assert.ok(!(result.error ?? "").includes("at "));
  });

  test("never targets anything other than the given container name and port", async () => {
    let seen: { hostname: string; port: number } | null = null;
    const client: DetailedHttpProbeClient = {
      async request(options) {
        seen = { hostname: options.hostname, port: options.port };
        return okResult();
      }
    };
    await probeInternalContainer(client, "app-mflabs", 53123);
    assert.deepEqual(seen, { hostname: "app-mflabs", port: 53123 });
  });
});

describe("probePublicRoute", () => {
  test("succeeds on a plain 200 response", async () => {
    const client = fakeClient(() => okResult());
    const result = await probePublicRoute(client, "wizard-test.apps.hookstats.com");
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.dnsMs, 10);
    assert.equal(result.tlsMs, 15);
  });

  test("reports a 502 as a failed probe with the status preserved", async () => {
    const client = fakeClient(() => okResult({ statusCode: 502 }));
    const result = await probePublicRoute(client, "wizard-test.apps.hookstats.com");
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 502);
    assert.match(result.error ?? "", /502/);
  });

  test("follows a same-host redirect", async () => {
    let calls = 0;
    const client: DetailedHttpProbeClient = {
      async request(options) {
        calls += 1;
        if (options.path === "/") {
          return okResult({ statusCode: 301, location: "/home" });
        }
        assert.equal(options.path, "/home");
        return okResult({ statusCode: 200 });
      }
    };
    const result = await probePublicRoute(client, "wizard-test.apps.hookstats.com");
    assert.equal(result.ok, true);
    assert.equal(result.redirectCount, 1);
    assert.equal(calls, 2);
  });

  test("blocks and reports a redirect to an untrusted host, never following it", async () => {
    let calls = 0;
    const client: DetailedHttpProbeClient = {
      async request() {
        calls += 1;
        return okResult({ statusCode: 302, location: "https://evil.example.com/steal" });
      }
    };
    const result = await probePublicRoute(client, "wizard-test.apps.hookstats.com");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /untrusted host/i);
    assert.equal(calls, 1);
  });

  test("reports a connection failure without throwing", async () => {
    const client: DetailedHttpProbeClient = {
      async request() {
        throw new Error("connect ECONNREFUSED");
      }
    };
    const result = await probePublicRoute(client, "wizard-test.apps.hookstats.com");
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, null);
  });
});

describe("sanitizeResourceEntry", () => {
  test("strips the query string and hash, keeping only host+path", () => {
    const sanitized = sanitizeResourceEntry(
      {
        url: "https://fonts.gstatic.com/s/inter/v12/font.woff2?token=SECRET123&sig=abc#frag",
        initiatorType: "css",
        startMs: 10,
        durationMs: 200,
        transferBytes: 5000,
        statusOk: true
      },
      "wizard-test.apps.hookstats.com"
    );
    assert.ok(sanitized);
    assert.equal(sanitized?.host, "fonts.gstatic.com");
    assert.ok(!sanitized?.path.includes("token"));
    assert.ok(!sanitized?.path.includes("SECRET123"));
    assert.equal(sanitized?.category, "font");
    assert.equal(sanitized?.firstParty, false);
  });

  test("classifies a first-party JS bundle correctly", () => {
    const sanitized = sanitizeResourceEntry(
      {
        url: "https://wizard-test.apps.hookstats.com/assets/index-abc123.js",
        initiatorType: "script",
        startMs: 5,
        durationMs: 120,
        transferBytes: 90000,
        statusOk: true
      },
      "wizard-test.apps.hookstats.com"
    );
    assert.equal(sanitized?.category, "javascript");
    assert.equal(sanitized?.firstParty, true);
  });

  test("classifies a Google Fonts stylesheet (fonts.googleapis.com) as font, not css", () => {
    const sanitized = sanitizeResourceEntry(
      {
        url: "https://fonts.googleapis.com/css2?family=Outfit:wght@400;700&display=swap",
        initiatorType: "link",
        startMs: 10,
        durationMs: 90,
        transferBytes: 1200,
        statusOk: true
      },
      "wizard-test.apps.hookstats.com"
    );
    assert.equal(sanitized?.category, "font");
    assert.equal(sanitized?.host, "fonts.googleapis.com");
    assert.equal(sanitized?.firstParty, false);
    assert.ok(!sanitized?.path.includes("family"));
  });

  test("classifies a Google Fonts font file (fonts.gstatic.com, .woff2) as font", () => {
    const sanitized = sanitizeResourceEntry(
      {
        url: "https://fonts.gstatic.com/s/outfit/v11/QGYyz_MVcBeNP4NjuGObqx1XmO1I4WBP.woff2",
        initiatorType: "css",
        startMs: 10,
        durationMs: 250,
        transferBytes: 22000,
        statusOk: true
      },
      "wizard-test.apps.hookstats.com"
    );
    assert.equal(sanitized?.category, "font");
  });

  test("classifies an ordinary first-party stylesheet as css, not font", () => {
    const sanitized = sanitizeResourceEntry(
      {
        url: "https://wizard-test.apps.hookstats.com/styles.css",
        initiatorType: "link",
        startMs: 0,
        durationMs: 40,
        transferBytes: 8000,
        statusOk: true
      },
      "wizard-test.apps.hookstats.com"
    );
    assert.equal(sanitized?.category, "css");
    assert.equal(sanitized?.firstParty, true);
  });

  test("does not treat a spoofed lookalike hostname as the real Google Fonts host", () => {
    const sanitized = sanitizeResourceEntry(
      {
        url: "https://fonts.googleapis.com.attacker.example/style.css",
        initiatorType: "link",
        startMs: 0,
        durationMs: 40,
        transferBytes: 500,
        statusOk: true
      },
      "wizard-test.apps.hookstats.com"
    );
    assert.equal(sanitized?.host, "fonts.googleapis.com.attacker.example");
    assert.equal(sanitized?.category, "css");
    assert.notEqual(sanitized?.category, "font");
  });

  test("rejects a malformed or non-http(s) URL rather than storing it raw", () => {
    assert.equal(
      sanitizeResourceEntry(
        { url: "javascript:alert(1)", initiatorType: "script", startMs: 0, durationMs: 1, transferBytes: null, statusOk: true },
        "wizard-test.apps.hookstats.com"
      ),
      null
    );
    assert.equal(
      sanitizeResourceEntry(
        { url: "not a url", initiatorType: "script", startMs: 0, durationMs: 1, transferBytes: null, statusOk: true },
        "wizard-test.apps.hookstats.com"
      ),
      null
    );
  });

  test("rejects NaN/negative/extreme timing values", () => {
    assert.equal(
      sanitizeResourceEntry(
        { url: "https://example.com/a.js", initiatorType: "script", startMs: Number.NaN, durationMs: 1, transferBytes: null, statusOk: true },
        "wizard-test.apps.hookstats.com"
      ),
      null
    );
    assert.equal(
      sanitizeResourceEntry(
        { url: "https://example.com/a.js", initiatorType: "script", startMs: 0, durationMs: -5, transferBytes: null, statusOk: true },
        "wizard-test.apps.hookstats.com"
      ),
      null
    );
    assert.equal(
      sanitizeResourceEntry(
        {
          url: "https://example.com/a.js",
          initiatorType: "script",
          startMs: 0,
          durationMs: 999999999,
          transferBytes: null,
          statusOk: true
        },
        "wizard-test.apps.hookstats.com"
      ),
      null
    );
  });
});

describe("summarizeResourcesByCategory / topSlowestResources", () => {
  test("aggregates counts, sizes, and the slowest path per category", () => {
    const entries = [
      sanitizeResourceEntry(
        { url: "https://fonts.gstatic.com/a.woff2", initiatorType: "css", startMs: 0, durationMs: 300, transferBytes: 2000, statusOk: true },
        "wizard-test.apps.hookstats.com"
      )!,
      sanitizeResourceEntry(
        { url: "https://fonts.gstatic.com/b.woff2", initiatorType: "css", startMs: 0, durationMs: 800, transferBytes: 3000, statusOk: false },
        "wizard-test.apps.hookstats.com"
      )!
    ];

    const summary = summarizeResourcesByCategory(entries);
    const fontSummary = summary.find((s) => s.category === "font");
    assert.ok(fontSummary);
    assert.equal(fontSummary?.count, 2);
    assert.equal(fontSummary?.totalTransferBytes, 5000);
    assert.equal(fontSummary?.slowestDurationMs, 800);
    assert.equal(fontSummary?.failedCount, 1);
  });

  test("returns the slowest resources first, bounded to the requested count", () => {
    const entries = [50, 900, 300, 10].map(
      (durationMs, index) =>
        sanitizeResourceEntry(
          { url: `https://example.com/r${index}.js`, initiatorType: "script", startMs: 0, durationMs, transferBytes: 100, statusOk: true },
          "wizard-test.apps.hookstats.com"
        )!
    );
    const top = topSlowestResources(entries, 2);
    assert.equal(top.length, 2);
    assert.equal(top[0].durationMs, 900);
    assert.equal(top[1].durationMs, 300);
  });
});

describe("diagnosePerformance", () => {
  const fastPublic: PublicProbeResult = {
    ok: true,
    totalMs: 100,
    dnsMs: 5,
    connectMs: 10,
    tlsMs: 10,
    ttfbMs: 100,
    downloadMs: 10,
    statusCode: 200,
    responseBytes: 1000,
    redirectCount: 0,
    finalHost: "wizard-test.apps.hookstats.com",
    error: null
  };
  const fastInternal: InternalProbeResult = {
    ok: true,
    totalMs: 50,
    connectMs: 5,
    ttfbMs: 40,
    statusCode: 200,
    responseBytes: 1000,
    error: null
  };

  test("diagnoses browser-network when browser is slow but server-side probes are fast", () => {
    const result = diagnosePerformance({
      browser: { available: true, ttfbMs: 1500, totalLoadMs: 1800, dnsMs: 5, tlsMs: 5 },
      publicProbe: fastPublic,
      internalProbe: fastInternal,
      slowestThirdPartyMs: null,
      slowestFirstPartyResourceMs: null
    });
    assert.equal(result.category, "browser-network");
    assert.match(result.message, /likely|may be/i);
  });

  test("diagnoses public-route when internal is fast but public route fails", () => {
    const result = diagnosePerformance({
      browser: null,
      publicProbe: { ...fastPublic, ok: false, statusCode: 502, error: "Public route returned HTTP 502" },
      internalProbe: fastInternal,
      slowestThirdPartyMs: null,
      slowestFirstPartyResourceMs: null
    });
    assert.equal(result.category, "public-route");
  });

  test("diagnoses internal-application when the internal probe itself is slow", () => {
    const result = diagnosePerformance({
      browser: null,
      publicProbe: fastPublic,
      internalProbe: { ...fastInternal, totalMs: 900 },
      slowestThirdPartyMs: null,
      slowestFirstPartyResourceMs: null
    });
    assert.equal(result.category, "internal-application");
  });

  test("diagnoses frontend-resources when HTML is fast but page load is slow", () => {
    const result = diagnosePerformance({
      browser: { available: true, ttfbMs: 150, totalLoadMs: 5000, dnsMs: 5, tlsMs: 5 },
      publicProbe: fastPublic,
      internalProbe: fastInternal,
      slowestThirdPartyMs: null,
      slowestFirstPartyResourceMs: 4000
    });
    assert.equal(result.category, "frontend-resources");
  });

  test("diagnoses third-party-resources when a third-party asset is the slowest part of a slow page load", () => {
    const result = diagnosePerformance({
      browser: { available: true, ttfbMs: 150, totalLoadMs: 5000, dnsMs: 5, tlsMs: 5 },
      publicProbe: fastPublic,
      internalProbe: fastInternal,
      slowestThirdPartyMs: 4500,
      slowestFirstPartyResourceMs: 200
    });
    assert.equal(result.category, "third-party-resources");
  });

  test("is inconclusive when browser timing is unavailable and nothing else stands out", () => {
    const result = diagnosePerformance({
      browser: { available: false, ttfbMs: null, totalLoadMs: null, dnsMs: null, tlsMs: null },
      publicProbe: fastPublic,
      internalProbe: fastInternal,
      slowestThirdPartyMs: null,
      slowestFirstPartyResourceMs: null
    });
    assert.equal(result.category, "inconclusive");
    assert.match(result.message, /inconclusive/i);
  });

  test("never claims certainty — only hedged language", () => {
    const result = diagnosePerformance({
      browser: { available: true, ttfbMs: 1500, totalLoadMs: 1800, dnsMs: 5, tlsMs: 5 },
      publicProbe: fastPublic,
      internalProbe: fastInternal,
      slowestThirdPartyMs: null,
      slowestFirstPartyResourceMs: null
    });
    assert.doesNotMatch(result.message, /\bis certainly\b|\bdefinitely\b|\bproven\b/i);
  });
});
