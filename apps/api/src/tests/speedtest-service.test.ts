import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  normalizeSpeedtestResult,
  isValidSpeedtestUrl,
  normalizeBaseUrl,
  createSpeedtestProvider,
  saveSpeedtestConnection,
  runSpeedtest,
  type SpeedtestFetch
} from "../services/speedtest-service.js";
import { createAppDatabase } from "../database.js";

/*
 * Storing the API token goes through the same encrypted credential path as
 * the GitHub PAT, which needs a real 32-byte key present in the environment.
 * Set once for this file so the save/read paths exercise genuine
 * encryption rather than being skipped.
 */
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/** A realistic /api/v1/results/latest payload, per Speedtest Tracker's docs. */
function latestPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    service: "ookla",
    ping: 12.34,
    download: 30191234,
    upload: 5123456,
    download_bits: 241529872,
    upload_bits: 40987648,
    download_bits_human: "241.53 Mbps",
    upload_bits_human: "40.99 Mbps",
    healthy: true,
    status: "completed",
    scheduled: true,
    data: {
      isp: "Example ISP",
      ping: { low: 11, high: 15, jitter: 1.8, latency: 12.34 },
      server: { id: 1, name: "Example Server", location: "Somewhere" },
      packetLoss: 0.5
    },
    created_at: "2026-08-05T09:13:53.053Z",
    ...overrides
  };
}

describe("normalizeSpeedtestResult", () => {
  test("maps the flat /results/latest payload", () => {
    const reading = normalizeSpeedtestResult(latestPayload());

    assert.ok(reading);
    assert.equal(reading?.downloadHuman, "241.53 Mbps");
    assert.equal(reading?.uploadHuman, "40.99 Mbps");
    assert.equal(reading?.downloadBits, 241529872);
    assert.equal(reading?.pingMs, 12.34);
    assert.equal(reading?.jitterMs, 1.8);
    assert.equal(reading?.packetLoss, 0.5);
    assert.equal(reading?.isp, "Example ISP");
    assert.equal(reading?.serverName, "Example Server");
    assert.equal(reading?.healthy, true);
    assert.equal(reading?.measuredAt, "2026-08-05T09:13:53.053Z");
  });

  test("also accepts the wrapped { data: … } shape used by /results/{id}", () => {
    const reading = normalizeSpeedtestResult({ data: latestPayload(), message: "ok" });
    assert.equal(reading?.downloadHuman, "241.53 Mbps");
    assert.equal(reading?.pingMs, 12.34);
  });

  test("missing or wrongly-typed fields become null rather than throwing", () => {
    const reading = normalizeSpeedtestResult({
      ping: "not a number",
      download_bits_human: "",
      created_at: "2026-08-05T09:13:53.053Z",
      data: {}
    });

    assert.ok(reading, "a payload with a timestamp is still a reading");
    assert.equal(reading?.pingMs, null);
    assert.equal(reading?.downloadHuman, null);
    assert.equal(reading?.jitterMs, null);
    assert.equal(reading?.isp, null);
    assert.equal(reading?.healthy, null);
  });

  test("a successful reading is not flagged as failed", () => {
    assert.equal(normalizeSpeedtestResult(latestPayload())?.failed, false);
  });

  test("numeric strings are accepted — Laravel serialises decimal columns that way", () => {
    const reading = normalizeSpeedtestResult(
      latestPayload({ ping: "12.34", download_bits: "241529872" })
    );

    assert.equal(reading?.pingMs, 12.34);
    assert.equal(reading?.downloadBits, 241529872);
    assert.equal(reading?.failed, false);
  });

  test("falls back to the raw byte columns when the *_bits accessors are absent", () => {
    // The bare model has `download`/`upload` (bytes/sec) but not the
    // accessors, so a version that serialises it directly must still work.
    const reading = normalizeSpeedtestResult(
      latestPayload({
        download_bits: undefined,
        upload_bits: undefined,
        download_bits_human: undefined,
        upload_bits_human: undefined
      })
    );

    assert.equal(reading?.downloadBits, 30191234 * 8);
    assert.equal(reading?.uploadBits, 5123456 * 8);
    assert.equal(reading?.downloadHuman, "241.53 Mbps");
    assert.equal(reading?.failed, false);
  });

  test("a run that recorded no measurements is flagged as failed", () => {
    // Speedtest Tracker still writes a row when a test fails, so a fresh
    // timestamp with no numbers must read as "the test failed", not as a
    // reading full of blanks.
    const reading = normalizeSpeedtestResult({
      id: 43,
      status: "failed",
      created_at: "2026-08-05T13:10:20.000Z",
      data: { message: "No servers available" }
    });

    assert.equal(reading?.failed, true);
    assert.equal(reading?.failureMessage, "No servers available");
    assert.equal(reading?.measuredAt, "2026-08-05T13:10:20.000Z");
  });

  test("a failure whose data is a bare string still surfaces the reason", () => {
    const reading = normalizeSpeedtestResult({
      created_at: "2026-08-05T13:10:20.000Z",
      data: "Ookla CLI exited with code 1"
    });

    assert.equal(reading?.failed, true);
    assert.equal(reading?.failureMessage, "Ookla CLI exited with code 1");
  });

  test("a payload with nothing usable reports no reading at all", () => {
    assert.equal(normalizeSpeedtestResult({}), null);
    assert.equal(normalizeSpeedtestResult(null), null);
    assert.equal(normalizeSpeedtestResult("nonsense"), null);
  });
});

describe("URL handling", () => {
  test("accepts http and https, rejects anything else", () => {
    assert.equal(isValidSpeedtestUrl("https://speedtest.example.com"), true);
    assert.equal(isValidSpeedtestUrl("http://10.0.0.5:8080"), true);
    assert.equal(isValidSpeedtestUrl("ftp://example.com"), false);
    assert.equal(isValidSpeedtestUrl("not a url"), false);
  });

  test("strips trailing slashes so the API path can't double up", () => {
    assert.equal(normalizeBaseUrl("https://example.com/"), "https://example.com");
    assert.equal(normalizeBaseUrl("https://example.com///"), "https://example.com");
  });
});

/** A fetch stub that records the request it was given. */
function stubFetch(
  response: { ok: boolean; status: number; body?: unknown },
  record?: { url?: string; headers?: Record<string, string> }
): SpeedtestFetch {
  return async (url, init) => {
    if (record) {
      record.url = url;
      record.headers = init.headers;
    }
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body ?? {}
    };
  };
}

describe("saveSpeedtestConnection", () => {
  test("refuses an invalid URL or empty token before contacting anything", async () => {
    const db = createAppDatabase(":memory:");
    let called = false;
    const fetchImpl: SpeedtestFetch = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const bad = await saveSpeedtestConnection({ appDatabase: db, fetchImpl }, {
      url: "not a url",
      token: "abc"
    });
    assert.equal(bad.success, false);
    assert.equal(bad.statusCode, 400);
    assert.equal(called, false, "must not call out with an invalid URL");
  });

  test("sends the bearer token and the Accept header the API requires", async () => {
    const db = createAppDatabase(":memory:");
    const record: { url?: string; headers?: Record<string, string> } = {};

    await saveSpeedtestConnection(
      { appDatabase: db, fetchImpl: stubFetch({ ok: true, status: 200, body: latestPayload() }, record) },
      { url: "https://speedtest.example.com/", token: "tok_123" }
    );

    assert.equal(record.url, "https://speedtest.example.com/api/v1/results/latest");
    assert.equal(record.headers?.Authorization, "Bearer tok_123");
    // Speedtest Tracker answers 406 without this.
    assert.equal(record.headers?.Accept, "application/json");
  });

  test("a rejected token is reported and never stored", async () => {
    const db = createAppDatabase(":memory:");

    const result = await saveSpeedtestConnection(
      { appDatabase: db, fetchImpl: stubFetch({ ok: false, status: 401 }) },
      { url: "https://speedtest.example.com", token: "wrong" }
    );

    assert.equal(result.success, false);
    assert.match(result.message ?? "", /Read Results/);
    assert.equal(db.getProviderCredential("speedtest-tracker"), null);
    assert.equal(db.getSetting("speedtest_url"), null);
  });

  test("a connected instance with no results yet (404) is accepted", async () => {
    const db = createAppDatabase(":memory:");

    const result = await saveSpeedtestConnection(
      { appDatabase: db, fetchImpl: stubFetch({ ok: false, status: 404 }) },
      { url: "https://speedtest.example.com", token: "tok" }
    );

    // A fresh Speedtest Tracker simply hasn't run a test yet — that's a
    // working connection, not a bad token.
    assert.equal(result.success, true);
    assert.equal(result.info?.configured, true);
  });

  test("the stored token is encrypted, never written in plaintext", async () => {
    const db = createAppDatabase(":memory:");

    await saveSpeedtestConnection(
      { appDatabase: db, fetchImpl: stubFetch({ ok: true, status: 200, body: latestPayload() }) },
      { url: "https://speedtest.example.com", token: "super-secret-token" }
    );

    const stored = db.getProviderCredential("speedtest-tracker");
    assert.ok(stored);
    assert.ok(!stored!.encryptedPayload.includes("super-secret-token"));
  });
});

describe("createSpeedtestProvider", () => {
  async function connectedDb() {
    const db = createAppDatabase(":memory:");
    await saveSpeedtestConnection(
      { appDatabase: db, fetchImpl: stubFetch({ ok: true, status: 200, body: latestPayload() }) },
      { url: "https://speedtest.example.com", token: "tok" }
    );
    return db;
  }

  test("caches a successful reading instead of re-querying every call", async () => {
    const db = await connectedDb();
    let calls = 0;
    let clock = 0;
    const provider = createSpeedtestProvider(
      {
        appDatabase: db,
        now: () => clock,
        fetchImpl: async () => {
          calls += 1;
          return { ok: true, status: 200, json: async () => latestPayload() };
        }
      },
      { ttlMs: 300_000 }
    );

    await provider.getLatest();
    clock += 1000;
    const second = await provider.getLatest();

    assert.equal(calls, 1);
    assert.equal(second.reading?.downloadHuman, "241.53 Mbps");
  });

  test("an error is not cached — the next call retries", async () => {
    const db = await connectedDb();
    let calls = 0;
    const provider = createSpeedtestProvider({
      appDatabase: db,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, status: 500, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => latestPayload() };
      }
    });

    const first = await provider.getLatest();
    assert.equal(first.reading, null);
    assert.match(first.error ?? "", /HTTP 500/);

    const second = await provider.getLatest();
    assert.equal(second.reading?.pingMs, 12.34);
    assert.equal(calls, 2);
  });

  test("invalidate() drops the cache so a reconnect is picked up immediately", async () => {
    const db = await connectedDb();
    let calls = 0;
    let clock = 0;
    const provider = createSpeedtestProvider(
      {
        appDatabase: db,
        now: () => clock,
        fetchImpl: async () => {
          calls += 1;
          return { ok: true, status: 200, json: async () => latestPayload() };
        }
      },
      { ttlMs: 300_000 }
    );

    await provider.getLatest();
    provider.invalidate();
    await provider.getLatest();

    assert.equal(calls, 2);
  });

  test("reports nothing configured (and makes no call) when there is no connection", async () => {
    const db = createAppDatabase(":memory:");
    let called = false;
    const provider = createSpeedtestProvider({
      appDatabase: db,
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
    });

    const result = await provider.getLatest();
    assert.equal(result.reading, null);
    assert.equal(result.error, null, "not being configured is not an error");
    assert.equal(called, false);
  });

  test("a rejected token surfaces an actionable message, not a raw status", async () => {
    const db = await connectedDb();
    const provider = createSpeedtestProvider({
      appDatabase: db,
      fetchImpl: stubFetch({ ok: false, status: 403 })
    });

    const result = await provider.getLatest();
    assert.equal(result.reading, null);
    assert.match(result.error ?? "", /Read Results/);
  });
});

describe("runSpeedtest", () => {
  async function connectedDb() {
    const db = createAppDatabase(":memory:");
    await saveSpeedtestConnection(
      { appDatabase: db, fetchImpl: stubFetch({ ok: true, status: 200, body: latestPayload() }) },
      { url: "https://speedtest.example.com", token: "tok" }
    );
    return db;
  }

  test("POSTs to the run endpoint with the bearer token and Accept header", async () => {
    const db = await connectedDb();
    const record: { url?: string; headers?: Record<string, string>; method?: string } = {};
    const fetchImpl: SpeedtestFetch = async (url, init) => {
      record.url = url;
      record.headers = init.headers;
      record.method = init.method;
      return { ok: true, status: 201, json: async () => ({ message: "queued" }) };
    };

    const result = await runSpeedtest({ appDatabase: db, fetchImpl });

    assert.equal(result.success, true);
    assert.equal(record.method, "POST");
    assert.equal(record.url, "https://speedtest.example.com/api/v1/speedtests/run");
    assert.equal(record.headers?.Authorization, "Bearer tok");
    assert.equal(record.headers?.Accept, "application/json");
  });

  test("a token without the Run Speedtest ability is reported as exactly that", async () => {
    const db = await connectedDb();

    const result = await runSpeedtest({
      appDatabase: db,
      fetchImpl: stubFetch({ ok: false, status: 403 })
    });

    assert.equal(result.success, false);
    // The common case is a token issued with only "Read Results" — say so
    // rather than surfacing a bare 403.
    assert.match(result.message, /Run Speedtest/);
  });

  test("refuses, without calling out, when nothing is connected", async () => {
    const db = createAppDatabase(":memory:");
    let called = false;
    const fetchImpl: SpeedtestFetch = async () => {
      called = true;
      return { ok: true, status: 201, json: async () => ({}) };
    };

    const result = await runSpeedtest({ appDatabase: db, fetchImpl });

    assert.equal(result.success, false);
    assert.match(result.message, /No Speedtest Tracker is connected/);
    assert.equal(called, false);
  });

  test("an unreachable instance is reported, not thrown", async () => {
    const db = await connectedDb();
    const fetchImpl: SpeedtestFetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await runSpeedtest({ appDatabase: db, fetchImpl });
    assert.equal(result.success, false);
    assert.match(result.message, /Could not reach/);
  });
});
