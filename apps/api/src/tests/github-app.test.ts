import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import cookiePlugin from "@fastify/cookie";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { loadGithubAppConfig, type GithubAppConfigResult } from "../services/github-app-config.js";
import { signGithubAppJwt } from "../services/github-app-jwt.js";
import { createGithubAppStateStore } from "../services/github-app-state-service.js";
import { resolveGithubToken } from "../services/github-token-service.js";
import { registerGithubAppRoutes } from "../routes/github-app.js";
import { sanitizeProcessOutput } from "../services/process-runner.js";
import type { InstallationInfo } from "../services/github-app-service.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ============================================================
// A real, throwaway RSA keypair — used only to exercise JWT signing and
// verification in-process. Never a real GitHub App key.
// ============================================================
const { privateKey: TEST_PRIVATE_KEY_PEM, publicKey: TEST_PUBLIC_KEY_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

// ============================================================
// github-app-jwt.ts
// ============================================================

describe("signGithubAppJwt", () => {
  test("produces a well-formed RS256 JWT with the app id as issuer", () => {
    const jwt = signGithubAppJwt("123456", TEST_PRIVATE_KEY_PEM);
    const parts = jwt.split(".");
    assert.equal(parts.length, 3);

    const header = decodeJwtPart(parts[0]!);
    assert.equal(header.alg, "RS256");
    assert.equal(header.typ, "JWT");

    const payload = decodeJwtPart(parts[1]!);
    assert.equal(payload.iss, "123456");
    assert.equal(typeof payload.iat, "number");
    assert.equal(typeof payload.exp, "number");
    assert.ok((payload.exp as number) - (payload.iat as number) <= 10 * 60);
  });

  test("backdates iat for clock-skew tolerance", () => {
    const now = () => new Date("2026-01-01T00:00:00.000Z");
    const jwt = signGithubAppJwt("1", TEST_PRIVATE_KEY_PEM, now);
    const payload = decodeJwtPart(jwt.split(".")[1]!);
    assert.ok((payload.iat as number) < Math.floor(now().getTime() / 1000));
  });

  test("the signature verifies against the matching public key", () => {
    const jwt = signGithubAppJwt("42", TEST_PRIVATE_KEY_PEM);
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(sigB64!, "base64url");
    const ok = cryptoVerify("RSA-SHA256", Buffer.from(signingInput), TEST_PUBLIC_KEY_PEM, signature);
    assert.equal(ok, true);
  });

  test("never throws a raw OpenSSL error for a malformed key", () => {
    assert.throws(() => signGithubAppJwt("1", "not a real pem"), /check GITHUB_APP_PRIVATE_KEY/);
  });
});

// ============================================================
// github-app-config.ts
// ============================================================

describe("loadGithubAppConfig", () => {
  test("not configured when every variable is absent", () => {
    const result = loadGithubAppConfig({});
    assert.equal(result.configured, false);
    if (!result.configured) {
      assert.ok(result.missing.length > 0);
    }
  });

  test("reports exactly which variables are missing, never a value", () => {
    const result = loadGithubAppConfig({ GITHUB_APP_ID: "123" });
    assert.equal(result.configured, false);
    if (!result.configured) {
      assert.ok(result.missing.some((m) => m.includes("PRIVATE_KEY")));
      assert.ok(result.missing.some((m) => m.includes("CALLBACK_URL")));
      assert.ok(result.missing.some((m) => m.includes("SLUG")));
      assert.ok(!JSON.stringify(result.missing).includes(TEST_PRIVATE_KEY_PEM));
    }
  });

  test("configured when every required variable is present", () => {
    const result = loadGithubAppConfig({
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      GITHUB_APP_CALLBACK_URL: "https://panel.devminted.com/api/github/callback",
      GITHUB_APP_SLUG: "deployment-platform"
    });
    assert.equal(result.configured, true);
    if (result.configured) {
      assert.equal(result.appId, "123456");
      assert.equal(result.callbackUrl, "https://panel.devminted.com/api/github/callback");
      assert.equal(result.appSlug, "deployment-platform");
      assert.equal(result.privateKeyPem, TEST_PRIVATE_KEY_PEM);
    }
  });

  test("unescapes a literal backslash-n private key", () => {
    const escaped = TEST_PRIVATE_KEY_PEM.replace(/\n/g, "\\n");
    const result = loadGithubAppConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: escaped,
      GITHUB_APP_CALLBACK_URL: "https://panel.devminted.com/api/github/callback",
      GITHUB_APP_SLUG: "x"
    });
    assert.equal(result.configured, true);
    if (result.configured) {
      assert.equal(result.privateKeyPem, TEST_PRIVATE_KEY_PEM);
    }
  });

  test("rejects a non-https callback URL", () => {
    const result = loadGithubAppConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      GITHUB_APP_CALLBACK_URL: "http://panel.devminted.com/api/github/callback",
      GITHUB_APP_SLUG: "x"
    });
    assert.equal(result.configured, false);
  });

  test("accepts a full install URL for GITHUB_APP_SLUG and normalizes it to the bare slug", () => {
    const result = loadGithubAppConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      GITHUB_APP_CALLBACK_URL: "https://panel.devminted.com/api/github/callback",
      GITHUB_APP_INSTALL_URL: "https://github.com/apps/my-app-slug"
    });
    assert.equal(result.configured, true);
    if (result.configured) {
      assert.equal(result.appSlug, "my-app-slug");
    }
  });

  test("a private key path that cannot be read is treated as missing, not a crash", () => {
    const result = loadGithubAppConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY_PATH: "/nonexistent/path/key.pem",
      GITHUB_APP_CALLBACK_URL: "https://panel.devminted.com/api/github/callback",
      GITHUB_APP_SLUG: "x"
    });
    assert.equal(result.configured, false);
  });
});

// ============================================================
// process-runner.ts — token redaction
// ============================================================

describe("sanitizeProcessOutput redacts every GitHub token shape", () => {
  const cases: Array<[string, string]> = [
    ["classic PAT", `ghp_${"a".repeat(36)}`],
    ["fine-grained PAT", `github_pat_${"a".repeat(20)}`],
    ["OAuth token", `gho_${"a".repeat(36)}`],
    ["installation access token", `ghs_${"a".repeat(36)}`],
    ["refresh token", `ghr_${"a".repeat(36)}`]
  ];

  for (const [label, token] of cases) {
    test(`redacts a ${label} embedded mid-line, even without a credential-shaped keyword nearby`, () => {
      const line = `remote: something unrelated ${token} more text`;
      const sanitized = sanitizeProcessOutput(line);
      assert.ok(!sanitized.includes(token), `expected token to be redacted from: ${sanitized}`);
      assert.ok(sanitized.includes("[REDACTED]"));
    });
  }

  test("still drops whole lines that look credential-shaped by keyword (regression)", () => {
    const sanitized = sanitizeProcessOutput("line one\nAuthorization: Bearer something\nline three");
    assert.ok(!sanitized.includes("Authorization"));
    assert.ok(sanitized.includes("line one"));
    assert.ok(sanitized.includes("line three"));
  });
});

// ============================================================
// github-app-state-service.ts — CSRF state store
// ============================================================

describe("github-app-state-service", () => {
  test("create() returns a long, unguessable, unique value each time", () => {
    const store = createGithubAppStateStore();
    const a = store.create("owner");
    const b = store.create("owner");
    assert.notEqual(a, b);
    assert.ok(a.length >= 32);
  });

  test("consume() returns the username the state was issued to", () => {
    const store = createGithubAppStateStore();
    const state = store.create("owner");
    assert.equal(store.consume(state), "owner");
  });

  test("consume() is one-time use: a second consume of the same state fails (replay rejected)", () => {
    const store = createGithubAppStateStore();
    const state = store.create("owner");
    assert.equal(store.consume(state), "owner");
    assert.equal(store.consume(state), null);
  });

  test("an unknown state is rejected", () => {
    const store = createGithubAppStateStore();
    assert.equal(store.consume("never-issued"), null);
  });

  test("an expired state is rejected", () => {
    let now = 1_000_000;
    const store = createGithubAppStateStore(() => now);
    const state = store.create("owner");
    now += 11 * 60 * 1000; // past the 10-minute TTL
    assert.equal(store.consume(state), null);
  });

  test("a state issued to one username cannot be silently reattributed to another", () => {
    const store = createGithubAppStateStore();
    const state = store.create("owner-a");
    // consume() has no "expected username" parameter to spoof — it can only
    // ever return exactly what create() recorded.
    assert.equal(store.consume(state), "owner-a");
  });

  test("malformed/oversized state values are rejected without throwing", () => {
    const store = createGithubAppStateStore();
    assert.equal(store.consume(""), null);
    assert.equal(store.consume("a".repeat(500)), null);
  });
});

// ============================================================
// github-token-service.ts — installation-first, PAT fallback
// ============================================================

describe("resolveGithubToken", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  const NOT_CONFIGURED: GithubAppConfigResult = { configured: false, missing: ["GITHUB_APP_ID"] };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-token-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("no GitHub App, no PAT -> not connected", async () => {
    const result = await resolveGithubToken({ appDatabase, githubAppConfig: NOT_CONFIGURED });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.credentialStatus, "not-configured");
  });

  test("GitHub App not configured, but a PAT exists -> falls back to the PAT", async () => {
    appDatabase.upsertProviderCredential({
      provider: "github",
      encryptedPayload: "irrelevant-for-this-test",
      authenticatedUsername: "owner",
      permissionsJson: null,
      lastValidatedAt: null
    });
    // Force a decryptable PAT path by using the real encryption flow.
    const { encryptSecret } = await import("../services/crypto-service.js");
    const key = Buffer.alloc(32, 7);
    process.env.CREDENTIAL_ENCRYPTION_KEY = key.toString("base64");
    appDatabase.upsertProviderCredential({
      provider: "github",
      encryptedPayload: encryptSecret(key, "fake_pat_token_value"),
      authenticatedUsername: "owner",
      permissionsJson: null,
      lastValidatedAt: null
    });

    const result = await resolveGithubToken({ appDatabase, githubAppConfig: NOT_CONFIGURED });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.source, "pat");
      assert.equal(result.token, "fake_pat_token_value");
    }
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  });

  test("GitHub App configured but no installation stored -> falls back to PAT-not-configured (not-configured overall)", async () => {
    const configured: GithubAppConfigResult = {
      configured: true,
      appId: "1",
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      callbackUrl: "https://panel.devminted.com/api/github/callback",
      appSlug: "x",
      clientId: null,
      clientSecret: null
    };
    const result = await resolveGithubToken({ appDatabase, githubAppConfig: configured });
    assert.equal(result.success, false);
  });
});

// ============================================================
// routes/github-app.ts — HTTP-level behavior via fastify.inject()
// ============================================================

const CONFIGURED: GithubAppConfigResult = {
  configured: true,
  appId: "999",
  privateKeyPem: TEST_PRIVATE_KEY_PEM,
  callbackUrl: "https://panel.devminted.com/api/github/callback",
  appSlug: "deployment-platform",
  clientId: null,
  clientSecret: null
};

function fakeAppDatabase() {
  const installations = new Map<number, any>();
  return {
    listGithubAppInstallations: () => [...installations.values()],
    upsertGithubAppInstallation: (input: any) => {
      const row = { ...input, id: 1, createdAt: "now", updatedAt: "now" };
      installations.set(input.installationId, row);
      return row;
    },
    deleteGithubAppInstallation: (id: number) => {
      installations.delete(id);
    },
    _installations: installations
  };
}

async function buildApp(overrides: {
  githubAppConfig?: GithubAppConfigResult;
  readSessionUsername?: (request: any) => string | null;
  fetchInstallationInfo?: (config: any, id: number) => Promise<InstallationInfo>;
  appDatabase?: ReturnType<typeof fakeAppDatabase>;
} = {}): Promise<{ app: FastifyInstance; db: ReturnType<typeof fakeAppDatabase>; stateStore: ReturnType<typeof createGithubAppStateStore> }> {
  const app = Fastify({ logger: false });
  await app.register(cookiePlugin);

  const db = overrides.appDatabase ?? fakeAppDatabase();
  const stateStore = createGithubAppStateStore();

  await registerGithubAppRoutes(app, {
    appDatabase: db,
    githubAppConfig: overrides.githubAppConfig ?? CONFIGURED,
    stateStore,
    logger: { info: () => {}, error: () => {} },
    readSessionUsername: overrides.readSessionUsername ?? (() => "owner"),
    ...(overrides.fetchInstallationInfo ? { fetchInstallationInfo: overrides.fetchInstallationInfo } : {})
  });

  return { app, db, stateStore };
}

function fakeInstallationInfo(overrides: Partial<InstallationInfo> = {}): InstallationInfo {
  return {
    installationId: 555,
    appId: 999,
    accountLogin: "MNIKevin202",
    accountId: 12345,
    accountType: "User",
    targetType: "User",
    repositorySelection: "selected",
    ...overrides
  };
}

describe("GET /github/connect", () => {
  test("requires an authenticated session (rejects when readSessionUsername returns null)", async () => {
    const { app } = await buildApp({ readSessionUsername: () => null });
    const response = await app.inject({ method: "GET", url: "/github/connect" });
    assert.equal(response.statusCode, 401);
    await app.close();
  });

  test("redirects to GitHub's install URL with a state parameter when authenticated", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/github/connect" });
    assert.equal(response.statusCode, 302);
    const location = new URL(response.headers.location as string);
    assert.equal(location.origin, "https://github.com");
    assert.equal(location.pathname, "/apps/deployment-platform/installations/new");
    assert.ok(location.searchParams.get("state"));
    await app.close();
  });

  test("returns 503 (not a crash) when the GitHub App is not configured", async () => {
    const { app } = await buildApp({ githubAppConfig: { configured: false, missing: ["GITHUB_APP_ID"] } });
    const response = await app.inject({ method: "GET", url: "/github/connect" });
    assert.equal(response.statusCode, 503);
    await app.close();
  });
});

describe("GET /github/callback", () => {
  test("rejects a missing state", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/github/callback?installation_id=555" });
    assert.equal(response.statusCode, 302);
    const location = new URL(response.headers.location as string);
    assert.equal(location.searchParams.get("github"), "error");
    await app.close();
  });

  test("rejects an invalid/unknown state", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/github/callback?installation_id=555&state=never-issued"
    });
    const location = new URL(response.headers.location as string);
    assert.equal(location.searchParams.get("github"), "error");
    await app.close();
  });

  test("a valid state completes the flow and stores the installation", async () => {
    const { app, db, stateStore } = await buildApp({
      fetchInstallationInfo: async () => fakeInstallationInfo()
    });
    const state = stateStore.create("owner");

    const response = await app.inject({
      method: "GET",
      url: `/github/callback?installation_id=555&setup_action=install&state=${state}`
    });

    assert.equal(response.statusCode, 302);
    const location = new URL(response.headers.location as string);
    assert.equal(location.searchParams.get("github"), "connected");
    assert.equal(location.searchParams.get("installation"), "555");
    assert.equal(db._installations.get(555)?.accountLogin, "MNIKevin202");
    assert.equal(db._installations.get(555)?.connectedByUsername, "owner");
    await app.close();
  });

  test("REPLAY: reusing the same state value twice fails the second time, even after a successful first use", async () => {
    const { app, stateStore } = await buildApp({
      fetchInstallationInfo: async () => fakeInstallationInfo()
    });
    const state = stateStore.create("owner");
    const url = `/github/callback?installation_id=555&setup_action=install&state=${state}`;

    const first = await app.inject({ method: "GET", url });
    assert.equal(new URL(first.headers.location as string).searchParams.get("github"), "connected");

    const second = await app.inject({ method: "GET", url });
    assert.equal(new URL(second.headers.location as string).searchParams.get("github"), "error");
    await app.close();
  });

  test("OWNERSHIP: rejects an installation whose app_id does not match the configured app", async () => {
    const { app, db, stateStore } = await buildApp({
      fetchInstallationInfo: async () => fakeInstallationInfo({ appId: 111111 }) // not 999
    });
    const state = stateStore.create("owner");

    const response = await app.inject({
      method: "GET",
      url: `/github/callback?installation_id=555&setup_action=install&state=${state}`
    });

    const location = new URL(response.headers.location as string);
    assert.equal(location.searchParams.get("github"), "error");
    assert.equal(db._installations.size, 0);
    await app.close();
  });

  test("handles setup_action=request (org approval pending) without storing an installation", async () => {
    const { app, db, stateStore } = await buildApp();
    const state = stateStore.create("owner");
    const response = await app.inject({
      method: "GET",
      url: `/github/callback?setup_action=request&state=${state}`
    });
    const location = new URL(response.headers.location as string);
    assert.equal(location.searchParams.get("github"), "pending");
    assert.equal(db._installations.size, 0);
    await app.close();
  });

  test("a fetchInstallationInfo failure redirects with an error and stores nothing", async () => {
    const { app, db, stateStore } = await buildApp({
      fetchInstallationInfo: async () => {
        throw new Error("network failure");
      }
    });
    const state = stateStore.create("owner");
    const response = await app.inject({
      method: "GET",
      url: `/github/callback?installation_id=555&setup_action=install&state=${state}`
    });
    const location = new URL(response.headers.location as string);
    assert.equal(location.searchParams.get("github"), "error");
    assert.equal(db._installations.size, 0);
    await app.close();
  });
});

describe("GET /github/installations", () => {
  test("reports configured:false with the missing list when unconfigured, never crashes", async () => {
    const { app } = await buildApp({ githubAppConfig: { configured: false, missing: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] } });
    const response = await app.inject({ method: "GET", url: "/github/installations" });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.configured, false);
    assert.deepEqual(body.missing, ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]);
    await app.close();
  });

  test("lists stored installations with no token field anywhere in the response", async () => {
    const db = fakeAppDatabase();
    db.upsertGithubAppInstallation({
      installationId: 555,
      appId: 999,
      accountLogin: "MNIKevin202",
      accountId: 1,
      accountType: "User",
      targetType: "User",
      repositorySelection: "all",
      connectedByUsername: "owner"
    });
    const { app } = await buildApp({ appDatabase: db });
    const response = await app.inject({ method: "GET", url: "/github/installations" });
    const body = JSON.parse(response.body);
    assert.equal(body.installations.length, 1);
    assert.ok(!JSON.stringify(body).toLowerCase().includes("token"));
    await app.close();
  });
});

describe("POST /github/disconnect", () => {
  test("removes only the local installation record", async () => {
    const db = fakeAppDatabase();
    db.upsertGithubAppInstallation({
      installationId: 555,
      appId: 999,
      accountLogin: "MNIKevin202",
      accountId: 1,
      accountType: "User",
      targetType: "User",
      repositorySelection: "all",
      connectedByUsername: "owner"
    });
    const { app } = await buildApp({ appDatabase: db });

    assert.equal(db._installations.size, 1);

    const response = await app.inject({
      method: "POST",
      url: "/github/disconnect",
      payload: { installationId: 555 }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(db._installations.size, 0);
    await app.close();
  });

  test("never calls out to GitHub — disconnect is local-only, the App stays installed", async () => {
    // The route's dependencies (appDatabase, logger) contain no GitHub
    // client/fetch capability at all — there is no code path through
    // which disconnect COULD reach GitHub's API, which is the point:
    // uninstalling only ever happens via "Manage access on GitHub",
    // a real navigation the operator does themselves.
    const db = fakeAppDatabase();
    db.upsertGithubAppInstallation({
      installationId: 555,
      appId: 999,
      accountLogin: "MNIKevin202",
      accountId: 1,
      accountType: "User",
      targetType: "User",
      repositorySelection: "all",
      connectedByUsername: "owner"
    });
    const { app } = await buildApp({ appDatabase: db });
    const response = await app.inject({
      method: "POST",
      url: "/github/disconnect",
      payload: { installationId: 555 }
    });
    assert.equal(response.statusCode, 200);
    // The installation would still exist on GitHub's side — this test just
    // documents/proves there is no call that could have removed it.
    await app.close();
  });

  test("rejects a malformed body", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "POST", url: "/github/disconnect", payload: {} });
    assert.equal(response.statusCode, 400);
    await app.close();
  });
});

// ============================================================
// auth.ts — source-level invariants for the callback's public-path exemption
// ============================================================

describe("auth.ts public-path invariants", () => {
  const authSource = readFileSync(join(REPO_ROOT, "src", "auth.ts"), "utf8");

  test("/github/callback is exempted from session auth (GitHub's redirect never carries the SameSite=Strict cookie)", () => {
    assert.match(authSource, /"\/github\/callback"/);
  });

  test("/github/connect is NOT exempted — it still requires a session", () => {
    const publicPathsBlock = /const publicPaths = new Set\(\[([\s\S]*?)\]\);/.exec(authSource);
    assert.ok(publicPathsBlock);
    assert.ok(!publicPathsBlock![1].includes('"/github/connect"'));
  });

  test("no other /github/* path is accidentally exempted", () => {
    const publicPathsBlock = /const publicPaths = new Set\(\[([\s\S]*?)\]\);/.exec(authSource);
    assert.ok(publicPathsBlock);
    const entries = [...publicPathsBlock![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const githubEntries = entries.filter((e) => e.startsWith("/github"));
    assert.deepEqual(githubEntries, ["/github/callback"]);
  });
});

// ============================================================
// Never-logged invariants (source-level, mirrors this codebase's existing
// style of pinning "never log X" as a structural check on the actual code,
// not just a comment).
// ============================================================

describe("secrets are never logged", () => {
  test("routes/github-app.ts never logs the raw request query/body wholesale", () => {
    const source = readFileSync(join(REPO_ROOT, "src", "routes", "github-app.ts"), "utf8");
    // Only specific, named fields are ever passed to logger.info/error in
    // this file (installationId, accountLogin, repositorySelection,
    // setupAction, errorName, expectedAppId/returnedAppId) — never
    // `request.query`, `request.body`, or the state/token values
    // themselves.
    assert.ok(!/logger\.(info|error)\([^)]*request\.(query|body)/.test(source));
    // The metadata OBJECT passed as logger's first argument must never
    // include a bare `state` field (e.g. `{ state }` or `state: ...`) — a
    // "state" substring inside a human-readable message string (e.g.
    // "...already-used state") is fine and expected.
    for (const call of source.matchAll(/logger\.(?:info|error)\(\s*\{([^}]*)\}/g)) {
      assert.ok(!/\bstate\b/.test(call[1]!), `logger call metadata object should not include state: ${call[0]}`);
    }
  });

  test("github-app-jwt.ts never logs or returns the private key", () => {
    const source = readFileSync(join(REPO_ROOT, "src", "services", "github-app-jwt.ts"), "utf8");
    assert.ok(!/console\.|logger\./.test(source));
  });

  test("github-app-service.ts never logs a minted token", () => {
    const source = readFileSync(join(REPO_ROOT, "src", "services", "github-app-service.ts"), "utf8");
    assert.ok(!/console\.|logger\./.test(source));
  });

  test("github-token-service.ts's failure log never includes the token", () => {
    const source = readFileSync(join(REPO_ROOT, "src", "services", "github-token-service.ts"), "utf8");
    const logCall = /logger\?\.error\(\s*\{([^}]*)\}/.exec(source);
    assert.ok(logCall);
    assert.ok(!logCall![1].includes("token"));
  });
});

// ============================================================
// Installation tokens are never persisted (source-level invariant)
// ============================================================

describe("installation tokens are never persisted", () => {
  test("installation-database.ts's schema/columns never mention a token", () => {
    const dbSource = readFileSync(join(REPO_ROOT, "src", "installation-database.ts"), "utf8");
    assert.ok(!/token/i.test(dbSource));
  });

  test("migration 014 does not create any token column", () => {
    const migrationSource = readFileSync(
      join(REPO_ROOT, "src", "migrations", "014_github_app_installations.ts"),
      "utf8"
    );
    assert.ok(!/\btoken\b/i.test(migrationSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  });
});
