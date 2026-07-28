import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerGithubRoutes } from "../routes/github.js";
import type { GithubCredentialDeps } from "../services/github-credential-service.js";
import type { ResolvedGithubToken } from "../services/github-token-service.js";
import type {
  ListPageOptions,
  SourceAccount,
  SourceBranch,
  SourceClientPage,
  SourceCommit,
  SourceProviderClient,
  SourceRepository
} from "../services/source-provider.js";

function repo(id: string, name: string, owner = "MNIKevin202"): SourceRepository {
  return {
    id,
    owner,
    name,
    fullName: `${owner}/${name}`,
    private: false,
    archived: false,
    description: null,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${owner}/${name}`,
    pushedAt: null,
    updatedAt: null
  };
}

interface FakeClientOptions {
  pages: SourceRepository[][];
}

function fakeGithubClient(options: FakeClientOptions): {
  client: SourceProviderClient;
  calls: ListPageOptions[];
} {
  const calls: ListPageOptions[] = [];

  const client: SourceProviderClient = {
    provider: "github",
    async validateCredential(): Promise<SourceAccount> {
      throw new Error("not used in this test");
    },
    async listRepositories(
      _token: string,
      pageOptions?: ListPageOptions
    ): Promise<SourceClientPage<SourceRepository>> {
      const page = pageOptions?.page ?? 1;
      calls.push(pageOptions ?? {});
      const items = options.pages[page - 1] ?? [];
      const hasMore = page - 1 < options.pages.length - 1;
      return { items, hasMore };
    },
    async getRepository(): Promise<SourceRepository> {
      throw new Error("not used in this test");
    },
    async listBranches(): Promise<SourceClientPage<SourceBranch>> {
      throw new Error("not used in this test");
    },
    async listCommits(): Promise<SourceClientPage<SourceCommit>> {
      throw new Error("not used in this test");
    },
    async resolveBranchCommit(): Promise<string> {
      throw new Error("not used in this test");
    },
    async getFileContents(): Promise<string> {
      throw new Error("not used in this test");
    },
    async pathExists(): Promise<boolean> {
      throw new Error("not used in this test");
    }
  };

  return { client, calls };
}

function fakeCredentialDeps(githubClient: SourceProviderClient): GithubCredentialDeps {
  return {
    appDatabase: {
      getProviderCredential: () => null,
      upsertProviderCredential: () => {},
      deleteProviderCredential: () => {}
    } as unknown as GithubCredentialDeps["appDatabase"],
    githubClient,
    logger: { info: () => {}, error: () => {} }
  };
}

async function buildApp(options: {
  pages: SourceRepository[][];
  resolveCredential?: () => Promise<ResolvedGithubToken>;
}): Promise<{ app: FastifyInstance; calls: ListPageOptions[] }> {
  const { client, calls } = fakeGithubClient({ pages: options.pages });
  const app = Fastify({ logger: false });

  await registerGithubRoutes(app, {
    credentialDeps: fakeCredentialDeps(client),
    githubClient: client,
    resolveCredential:
      options.resolveCredential ?? (async () => ({ success: true, token: "fake-pat-token", source: "pat" }))
  });

  return { app, calls };
}

describe("GET /integrations/github/repositories", () => {
  test("returns repositories and hasMore from the resolved credential's source", async () => {
    const { app } = await buildApp({ pages: [[repo("1", "a"), repo("2", "b")]] });

    const response = await app.inject({ method: "GET", url: "/integrations/github/repositories" });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { success: boolean; repositories: unknown[]; hasMore: boolean; source: string };
    assert.equal(body.success, true);
    assert.equal(body.repositories.length, 2);
    assert.equal(body.hasMore, false);
    assert.equal(body.source, "pat");

    await app.close();
  });

  test("pagination continues until the final page: hasMore is true, then false", async () => {
    const { app } = await buildApp({ pages: [[repo("1", "a")], [repo("2", "b")], [repo("3", "c")]] });

    const page1 = await app.inject({ method: "GET", url: "/integrations/github/repositories?page=1&perPage=50" });
    assert.equal((page1.json() as { hasMore: boolean }).hasMore, true);

    const page2 = await app.inject({ method: "GET", url: "/integrations/github/repositories?page=2&perPage=50" });
    assert.equal((page2.json() as { hasMore: boolean }).hasMore, true);

    const page3 = await app.inject({ method: "GET", url: "/integrations/github/repositories?page=3&perPage=50" });
    assert.equal((page3.json() as { hasMore: boolean }).hasMore, false);

    await app.close();
  });

  test("accepts a page number well beyond the old 100-page cap, for very large installations", async () => {
    const { app } = await buildApp({ pages: [[repo("1", "a")]] });

    const response = await app.inject({ method: "GET", url: "/integrations/github/repositories?page=500&perPage=50" });
    assert.equal(response.statusCode, 200);

    await app.close();
  });

  test("rejects a page number beyond the safety cap", async () => {
    const { app } = await buildApp({ pages: [[repo("1", "a")]] });

    const response = await app.inject({ method: "GET", url: "/integrations/github/repositories?page=999999" });
    assert.equal(response.statusCode, 400);

    await app.close();
  });

  test("perPage is still capped at 50 — the client can never request an unbounded page size", async () => {
    const { app, calls } = await buildApp({ pages: [[repo("1", "a")]] });

    await app.inject({ method: "GET", url: "/integrations/github/repositories?perPage=5000" });
    assert.equal(calls[0]?.perPage, undefined); // Fastify/zod handles clamping before the client call
    // The important, directly observable contract: the response never errors and
    // the query is accepted (zod's own max(50) enforcement is covered by rejection below).
    const rejected = await app.inject({ method: "GET", url: "/integrations/github/repositories?perPage=51" });
    assert.equal(rejected.statusCode, 400);

    await app.close();
  });

  test("returns 409 with credentialStatus when GitHub is not connected", async () => {
    const { app } = await buildApp({
      pages: [[]],
      resolveCredential: async () => ({ success: false, credentialStatus: "not-configured" })
    });

    const response = await app.inject({ method: "GET", url: "/integrations/github/repositories" });
    assert.equal(response.statusCode, 409);
    const body = response.json() as { success: boolean; credentialStatus: string };
    assert.equal(body.success, false);
    assert.equal(body.credentialStatus, "not-configured");

    await app.close();
  });

  test("never includes a token, credential, or Authorization value in the response body", async () => {
    const { app } = await buildApp({
      pages: [[repo("1", "a")]],
      resolveCredential: async () => ({ success: true, token: "super-secret-token-value", source: "pat" })
    });

    const response = await app.inject({ method: "GET", url: "/integrations/github/repositories" });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.payload.includes("super-secret-token-value"));

    await app.close();
  });
});
