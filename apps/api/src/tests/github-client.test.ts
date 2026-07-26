import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createGithubClient } from "../services/github-client.js";
import { SourceClientError } from "../services/source-provider.js";

type FetchFn = typeof fetch;

async function withFakeFetch<T>(handler: FetchFn, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;

  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers }
  });
}

const TOKEN = "github_pat_test_token_value_should_never_leak";

describe("createGithubClient", () => {
  test("validateCredential returns a normalized account for a valid token", async () => {
    const client = createGithubClient();

    const account = await withFakeFetch(
      async (input) => {
        const url = String(input);
        assert.match(url, /\/user$/);
        return jsonResponse({ login: "octocat", html_url: "https://github.com/octocat" });
      },
      () => client.validateCredential(TOKEN)
    );

    assert.deepEqual(account, { username: "octocat", htmlUrl: "https://github.com/octocat" });
  });

  test("validateCredential throws invalid-token for a 401 response", async () => {
    const client = createGithubClient();

    await assert.rejects(
      () =>
        withFakeFetch(
          async () => jsonResponse({ message: "Bad credentials" }, { status: 401 }),
          () => client.validateCredential("bad-token")
        ),
      (error: unknown) => {
        assert.ok(error instanceof SourceClientError);
        assert.equal(error.kind, "invalid-token");
        assert.ok(!error.message.includes("bad-token"));
        return true;
      }
    );
  });

  test("classifies a network timeout (AbortError) distinctly", async () => {
    const client = createGithubClient();

    await assert.rejects(
      () =>
        withFakeFetch(
          async () => {
            const error = new DOMException("The operation was aborted", "AbortError");
            throw error;
          },
          () => client.validateCredential(TOKEN)
        ),
      (error: unknown) => {
        assert.ok(error instanceof SourceClientError);
        assert.equal(error.kind, "network-timeout");
        return true;
      }
    );
  });

  test("classifies a 403 with a zeroed rate limit header as rate-limited", async () => {
    const client = createGithubClient();

    await assert.rejects(
      () =>
        withFakeFetch(
          async () =>
            jsonResponse(
              { message: "API rate limit exceeded" },
              { status: 403, headers: { "x-ratelimit-remaining": "0" } }
            ),
          () => client.validateCredential(TOKEN)
        ),
      (error: unknown) => {
        assert.ok(error instanceof SourceClientError);
        assert.equal(error.kind, "rate-limited");
        return true;
      }
    );
  });

  test("classifies a 403 without a zeroed rate limit header as insufficient-permissions", async () => {
    const client = createGithubClient();

    await assert.rejects(
      () =>
        withFakeFetch(
          async () => jsonResponse({ message: "Forbidden" }, { status: 403 }),
          () => client.getRepository(TOKEN, "octocat", "private-repo")
        ),
      (error: unknown) => {
        assert.ok(error instanceof SourceClientError);
        assert.equal(error.kind, "insufficient-permissions");
        return true;
      }
    );
  });

  test("listRepositories paginates conservatively and reports hasMore from the Link header", async () => {
    const client = createGithubClient();

    const repoFixture = {
      id: 1,
      name: "repo-a",
      owner: { login: "octocat" },
      private: false,
      default_branch: "main",
      html_url: "https://github.com/octocat/repo-a"
    };

    const withNext = await withFakeFetch(
      async () =>
        jsonResponse([repoFixture], {
          headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' }
        }),
      () => client.listRepositories(TOKEN, { page: 1, perPage: 1 })
    );

    assert.equal(withNext.hasMore, true);

    const withoutNext = await withFakeFetch(
      async () => jsonResponse([repoFixture]),
      () => client.listRepositories(TOKEN, { page: 2, perPage: 1 })
    );

    assert.equal(withoutNext.hasMore, false);
  });

  test("listRepositories requests only supported parameters — no unsupported search/q parameter", async () => {
    const client = createGithubClient();

    let requestedUrl = "";

    await withFakeFetch(
      async (input) => {
        requestedUrl = String(input);
        return jsonResponse([]);
      },
      () => client.listRepositories(TOKEN, { page: 1, perPage: 10 })
    );

    const url = new URL(requestedUrl);
    assert.equal(url.pathname, "/user/repos");

    const allowedParams = new Set(["per_page", "page", "sort", "affiliation"]);
    for (const key of url.searchParams.keys()) {
      assert.ok(allowedParams.has(key), `unexpected query parameter: ${key}`);
    }
    assert.ok(!url.searchParams.has("q"));
    assert.ok(!url.searchParams.has("search"));
  });

  test("normalizes a private repository correctly", async () => {
    const client = createGithubClient();

    const repo = await withFakeFetch(
      async () =>
        jsonResponse({
          id: 42,
          name: "secret-repo",
          full_name: "octocat/secret-repo",
          owner: { login: "octocat" },
          private: true,
          archived: false,
          description: null,
          default_branch: "main",
          html_url: "https://github.com/octocat/secret-repo",
          pushed_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z"
        }),
      () => client.getRepository(TOKEN, "octocat", "secret-repo")
    );

    assert.equal(repo.private, true);
    assert.equal(repo.id, "42");
    assert.equal(repo.owner, "octocat");
    assert.equal(repo.defaultBranch, "main");
  });

  test("normalizes a branch", async () => {
    const client = createGithubClient();

    const page = await withFakeFetch(
      async () =>
        jsonResponse([{ name: "main", commit: { sha: "abc1234" }, protected: true }]),
      () => client.listBranches(TOKEN, "octocat", "hello-world")
    );

    assert.deepEqual(page.items, [{ name: "main", commitSha: "abc1234", protected: true }]);
  });

  test("normalizes a commit, falling back to the GitHub login when no author name is present", async () => {
    const client = createGithubClient();

    const page = await withFakeFetch(
      async () =>
        jsonResponse([
          {
            sha: "deadbeef",
            commit: { message: "Fix bug", author: { name: null, date: "2026-01-01T00:00:00Z" } },
            author: { login: "octocat" },
            html_url: "https://github.com/octocat/hello-world/commit/deadbeef"
          }
        ]),
      () => client.listCommits(TOKEN, "octocat", "hello-world", "main")
    );

    assert.equal(page.items[0].sha, "deadbeef");
    assert.equal(page.items[0].message, "Fix bug");
    assert.equal(page.items[0].authorName, "octocat");
  });

  test("pathExists returns true for a 200 response", async () => {
    const client = createGithubClient();

    const exists = await withFakeFetch(
      async () => jsonResponse({ type: "file", name: "Dockerfile", size: 120 }),
      () => client.pathExists(TOKEN, "octocat", "hello-world", "main", "Dockerfile")
    );

    assert.equal(exists, true);
  });

  test("pathExists returns false for a 404 response", async () => {
    const client = createGithubClient();

    const exists = await withFakeFetch(
      async () => jsonResponse({ message: "Not Found" }, { status: 404 }),
      () => client.pathExists(TOKEN, "octocat", "hello-world", "main", "missing/Dockerfile")
    );

    assert.equal(exists, false);
  });

  test("throws malformed-response for a body that isn't valid JSON", async () => {
    const client = createGithubClient();

    await assert.rejects(
      () =>
        withFakeFetch(
          async () => new Response("<html>not json</html>", { status: 200 }),
          () => client.validateCredential(TOKEN)
        ),
      (error: unknown) => {
        assert.ok(error instanceof SourceClientError);
        assert.equal(error.kind, "malformed-response");
        return true;
      }
    );
  });

  test("the token never appears in a thrown error message", async () => {
    const client = createGithubClient();

    try {
      await withFakeFetch(
        async () => jsonResponse({ message: "Bad credentials" }, { status: 401 }),
        () => client.validateCredential(TOKEN)
      );
      assert.fail("expected validateCredential to throw");
    } catch (error) {
      assert.ok(error instanceof SourceClientError);
      assert.ok(!error.message.includes(TOKEN));
    }
  });

  test("logs only sanitized fields — never the token or Authorization header", async () => {
    const events: unknown[] = [];
    const client = createGithubClient({ log: (event) => events.push(event) });

    await withFakeFetch(
      async () => jsonResponse({ login: "octocat" }),
      () => client.validateCredential(TOKEN)
    );

    assert.equal(events.length, 1);
    const serialized = JSON.stringify(events[0]);
    assert.ok(!serialized.includes(TOKEN));
    assert.ok(!serialized.toLowerCase().includes("authorization"));
  });

  describe("pathExists — bodyless request design", () => {
    test("never reads the response body, even on success", async () => {
      const client = createGithubClient();
      let bodyMethodCalled = false;

      const throwingResponse = new Response(null, { status: 200 });
      Object.defineProperty(throwingResponse, "text", {
        value: async () => {
          bodyMethodCalled = true;
          throw new Error("text() must never be called by pathExists");
        }
      });
      Object.defineProperty(throwingResponse, "json", {
        value: async () => {
          bodyMethodCalled = true;
          throw new Error("json() must never be called by pathExists");
        }
      });

      const exists = await withFakeFetch(
        async () => throwingResponse,
        () => client.pathExists(TOKEN, "octocat", "hello-world", "main", "Dockerfile")
      );

      assert.equal(exists, true);
      assert.equal(bodyMethodCalled, false);
    });

    test("returns false for a 404 without reading the body", async () => {
      const client = createGithubClient();
      let bodyMethodCalled = false;

      const throwingResponse = new Response(null, { status: 404 });
      Object.defineProperty(throwingResponse, "text", {
        value: async () => {
          bodyMethodCalled = true;
          throw new Error("text() must never be called by pathExists");
        }
      });
      Object.defineProperty(throwingResponse, "json", {
        value: async () => {
          bodyMethodCalled = true;
          throw new Error("json() must never be called by pathExists");
        }
      });

      const exists = await withFakeFetch(
        async () => throwingResponse,
        () => client.pathExists(TOKEN, "octocat", "hello-world", "main", "missing/Dockerfile")
      );

      assert.equal(exists, false);
      assert.equal(bodyMethodCalled, false);
    });

    test("a permission failure still throws a sanitized classification, never the token", async () => {
      const client = createGithubClient();

      await assert.rejects(
        () =>
          withFakeFetch(
            async () => jsonResponse({ message: "Forbidden" }, { status: 403 }),
            () => client.pathExists(TOKEN, "octocat", "private-repo", "main", "Dockerfile")
          ),
        (error: unknown) => {
          assert.ok(error instanceof SourceClientError);
          assert.equal(error.kind, "insufficient-permissions");
          assert.ok(!error.message.includes(TOKEN));
          return true;
        }
      );
    });

    test("never returns or stores response content — only a boolean", async () => {
      const client = createGithubClient();

      const result = await withFakeFetch(
        async () => jsonResponse({ type: "file", name: "Dockerfile", content: "base64-file-content-here", size: 999 }),
        () => client.pathExists(TOKEN, "octocat", "hello-world", "main", "Dockerfile")
      );

      assert.equal(typeof result, "boolean");
      assert.equal(result, true);
    });
  });

  describe("GitHub URL path-segment encoding", () => {
    test("encodes a safe nested Dockerfile path without altering the query string", async () => {
      const client = createGithubClient();
      let requestedUrl = "";

      await withFakeFetch(
        async (input) => {
          requestedUrl = String(input);
          return new Response(null, { status: 200 });
        },
        () => client.pathExists(TOKEN, "octocat", "hello-world", "main", "services/api/Dockerfile")
      );

      const url = new URL(requestedUrl);
      assert.equal(url.pathname, "/repos/octocat/hello-world/contents/services/api/Dockerfile");
      assert.equal(url.searchParams.get("ref"), "main");
    });

    test("a path segment containing '?' or '#' cannot inject a query string or fragment", async () => {
      const client = createGithubClient();
      let requestedUrl = "";

      await withFakeFetch(
        async (input) => {
          requestedUrl = String(input);
          return new Response(null, { status: 200 });
        },
        () => client.pathExists(TOKEN, "octocat", "hello-world", "main", "weird?a=b#frag")
      );

      const url = new URL(requestedUrl);
      // The "?" and "#" must be percent-encoded within the path — never
      // parsed as the start of a query string or fragment.
      assert.ok(url.pathname.includes("%3F"));
      assert.ok(url.pathname.includes("%23"));
      assert.equal(url.searchParams.get("ref"), "main");
      assert.equal(url.hash, "");
    });

    test("a branch name containing '/' is encoded as a single opaque segment", async () => {
      const client = createGithubClient();
      let requestedUrl = "";

      await withFakeFetch(
        async (input) => {
          requestedUrl = String(input);
          return jsonResponse({ name: "feature/thing", commit: { sha: "abc1234" }, protected: false });
        },
        () => client.resolveBranchCommit(TOKEN, "octocat", "hello-world", "feature/thing")
      );

      assert.ok(requestedUrl.includes("/branches/feature%2Fthing"));
      assert.ok(!requestedUrl.includes("/branches/feature/thing"));
    });
  });

  describe("strict normalization — malformed-response cases", () => {
    test("account: missing login throws malformed-response", async () => {
      const client = createGithubClient();
      await assert.rejects(
        () => withFakeFetch(async () => jsonResponse({}), () => client.validateCredential(TOKEN)),
        (error: unknown) => error instanceof SourceClientError && error.kind === "malformed-response"
      );
    });

    test("account: non-HTTPS html_url throws malformed-response", async () => {
      const client = createGithubClient();
      await assert.rejects(
        () =>
          withFakeFetch(
            async () => jsonResponse({ login: "octocat", html_url: "http://github.com/octocat" }),
            () => client.validateCredential(TOKEN)
          ),
        (error: unknown) => error instanceof SourceClientError && error.kind === "malformed-response"
      );
    });

    const validRepo = {
      id: 1,
      name: "repo-a",
      owner: { login: "octocat" },
      default_branch: "main",
      html_url: "https://github.com/octocat/repo-a"
    };

    test("repository: missing id throws malformed-response", async () => {
      const client = createGithubClient();
      const { id: _id, ...withoutId } = validRepo;
      await assert.rejects(
        () => withFakeFetch(async () => jsonResponse(withoutId), () => client.getRepository(TOKEN, "octocat", "repo-a")),
        (error: unknown) => error instanceof SourceClientError && error.kind === "malformed-response"
      );
    });

    test("repository: empty owner.login throws malformed-response", async () => {
      const client = createGithubClient();
      await assert.rejects(
        () =>
          withFakeFetch(
            async () => jsonResponse({ ...validRepo, owner: { login: "" } }),
            () => client.getRepository(TOKEN, "octocat", "repo-a")
          ),
        (error: unknown) => error instanceof SourceClientError && error.kind === "malformed-response"
      );
    });

    test("repository: missing default_branch throws malformed-response", async () => {
      const client = createGithubClient();
      const { default_branch: _db, ...withoutBranch } = validRepo;
      await assert.rejects(
        () =>
          withFakeFetch(async () => jsonResponse(withoutBranch), () => client.getRepository(TOKEN, "octocat", "repo-a")),
        (error: unknown) => error instanceof SourceClientError && error.kind === "malformed-response"
      );
    });

    test("repository: non-HTTPS html_url throws malformed-response", async () => {
      const client = createGithubClient();
      await assert.rejects(
        () =>
          withFakeFetch(
            async () => jsonResponse({ ...validRepo, html_url: "ftp://github.com/octocat/repo-a" }),
            () => client.getRepository(TOKEN, "octocat", "repo-a")
          ),
        (error: unknown) => error instanceof SourceClientError && error.kind === "malformed-response"
      );
    });

    test("branch: missing commit.sha throws malformed-response", async () => {
      const client = createGithubClient();
      await assert.rejects(
        () =>
          withFakeFetch(
            async () => jsonResponse([{ name: "main", commit: {}, protected: false }]),
            () => client.listBranches(TOKEN, "octocat", "repo-a")
          ),
        (error: unknown) => error instanceof SourceClientError && error.kind === "malformed-response"
      );
    });

    test("branch: non-hex-looking commit.sha throws malformed-response", async () => {
      const client = createGithubClient();
      await assert.rejects(
        () =>
          withFakeFetch(
            async () => jsonResponse([{ name: "main", commit: { sha: "not-a-sha!" }, protected: false }]),
            () => client.listBranches(TOKEN, "octocat", "repo-a")
          ),
        (error: unknown) => error instanceof SourceClientError && error.kind === "malformed-response"
      );
    });

    test("commit: missing sha throws malformed-response", async () => {
      const client = createGithubClient();
      await assert.rejects(
        () =>
          withFakeFetch(
            async () =>
              jsonResponse([
                { commit: { message: "x" }, html_url: "https://github.com/octocat/repo-a/commit/abc1234" }
              ]),
            () => client.listCommits(TOKEN, "octocat", "repo-a", "main")
          ),
        (error: unknown) => error instanceof SourceClientError && error.kind === "malformed-response"
      );
    });

    test("commit: non-HTTPS html_url throws malformed-response", async () => {
      const client = createGithubClient();
      await assert.rejects(
        () =>
          withFakeFetch(
            async () =>
              jsonResponse([
                { sha: "abc1234", commit: { message: "x" }, html_url: "http://github.com/octocat/repo-a/commit/abc1234" }
              ]),
            () => client.listCommits(TOKEN, "octocat", "repo-a", "main")
          ),
        (error: unknown) => error instanceof SourceClientError && error.kind === "malformed-response"
      );
    });
  });
});
