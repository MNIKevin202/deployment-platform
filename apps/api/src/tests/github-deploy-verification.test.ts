import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { verifyInternalReachability, verifyPublicRoute } from "../services/github-deploy-service.js";
import type { HealthCheckHttpClient } from "../services/health-check-service.js";

describe("verifyInternalReachability", () => {
  test("is reachable when the app responds on the configured port, regardless of its HTTP status", async () => {
    const httpClient: HealthCheckHttpClient = {
      async request() {
        return { statusCode: 500, latencyMs: 5 };
      }
    };

    const result = await verifyInternalReachability(httpClient, "app-mflabs", 53123);
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 500);
  });

  test(
    "is unreachable (connection-refused style) when nothing is listening on the configured port",
    { timeout: 70000 },
    async () => {
      const httpClient: HealthCheckHttpClient = {
        async request() {
          throw new Error("connect ECONNREFUSED");
        }
      };

      const result = await verifyInternalReachability(httpClient, "app-mflabs", 80);
      assert.equal(result.reachable, false);
      assert.equal(result.statusCode, null);
      assert.match(result.message, /nothing responded on port 80/i);
    }
  );

  test("targets exactly the given container name, port, and path", async () => {
    let seenTarget: { hostname: string; port: number; path: string } | null = null;
    const httpClient: HealthCheckHttpClient = {
      async request({ hostname, port, path }) {
        seenTarget = { hostname, port, path };
        return { statusCode: 200, latencyMs: 1 };
      }
    };

    await verifyInternalReachability(httpClient, "app-mflabs", 53123, "api/ready");
    assert.deepEqual(seenTarget, { hostname: "app-mflabs", port: 53123, path: "/api/ready" });
  });
});

describe("verifyPublicRoute", () => {
  const originalFetch = globalThis.fetch;

  function restoreFetch() {
    globalThis.fetch = originalFetch;
  }

  test("succeeds on an ordinary 200 response", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
    try {
      const result = await verifyPublicRoute("wizard-test.apps.hookstats.com");
      assert.equal(result.ok, true);
      assert.equal(result.statusCode, 200);
    } finally {
      restoreFetch();
    }
  });

  test("uses the configured health path for public verification", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input) => {
      seenUrl = String(input);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const result = await verifyPublicRoute("wizard-test.apps.hookstats.com", "api/ready");
      assert.equal(result.ok, true);
      assert.equal(seenUrl, "https://wizard-test.apps.hookstats.com/api/ready");
    } finally {
      restoreFetch();
    }
  });

  test(
    "treats a 502 as a deployment failure, not an acceptable application response",
    { timeout: 15000 },
    async () => {
      globalThis.fetch = (async () => new Response(null, { status: 502 })) as typeof fetch;
      try {
        const result = await verifyPublicRoute("wizard-test.apps.hookstats.com");
        assert.equal(result.ok, false);
        assert.match(result.message, /502/);
      } finally {
        restoreFetch();
      }
    }
  );

  test(
    "treats a network failure as a deployment failure",
    { timeout: 15000 },
    async () => {
      globalThis.fetch = (async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }) as typeof fetch;
      try {
        const result = await verifyPublicRoute("wizard-test.apps.hookstats.com");
        assert.equal(result.ok, false);
        assert.equal(result.statusCode, null);
      } finally {
        restoreFetch();
      }
    }
  );

  test("accepts an ordinary 404 from the application itself — this is not a gateway-failure gate", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    try {
      const result = await verifyPublicRoute("wizard-test.apps.hookstats.com");
      assert.equal(result.ok, true);
      assert.equal(result.statusCode, 404);
    } finally {
      restoreFetch();
    }
  });
});
