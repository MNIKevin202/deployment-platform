import { afterEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useGithubRepositories } from "../hooks/useGithubRepositories";
import type { SourceRepository } from "../types/api";

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

interface FetchCall {
  url: string;
}

/** Serves a fixed sequence of pages (25 repos each) off /api/integrations/github/repositories, in order, regardless of the requested page number — good enough to prove the hook walks pages until hasMore is false. */
function installPagedFetchMock(pages: SourceRepository[][], opts: { source?: "installation" | "pat" } = {}) {
  const calls: FetchCall[] = [];
  let pageIndex = 0;

  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });

    if (!url.startsWith("/api/integrations/github/repositories")) {
      throw new Error(`Unhandled fetch in test: ${url}`);
    }

    const items = pages[pageIndex] ?? [];
    const hasMore = pageIndex < pages.length - 1;
    pageIndex += 1;

    return jsonResponse(200, {
      success: true,
      repositories: items,
      hasMore,
      source: opts.source ?? "installation"
    });
  });

  vi.stubGlobal("fetch", impl);
  return { calls, impl };
}

describe("useGithubRepositories", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("loads more than 20 repositories by walking multiple pages", async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => repo(String(i), `repo-a-${i}`));
    const page2 = Array.from({ length: 25 }, (_, i) => repo(String(25 + i), `repo-b-${i}`));
    installPagedFetchMock([page1, page2]);

    const { result } = renderHook(() => useGithubRepositories(true));

    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.repos.length).toBe(50);
    expect(result.current.repos.length).toBeGreaterThan(20);
  });

  test("pagination continues until the final GitHub page (hasMore false)", async () => {
    const page1 = [repo("1", "a")];
    const page2 = [repo("2", "b")];
    const page3 = [repo("3", "c")];
    const { calls } = installPagedFetchMock([page1, page2, page3]);

    const { result } = renderHook(() => useGithubRepositories(true));

    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.repos.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(calls.length).toBe(3);
    expect(calls[0]!.url).toContain("page=1");
    expect(calls[1]!.url).toContain("page=2");
    expect(calls[2]!.url).toContain("page=3");
  });

  test("duplicate repositories across pages are deduplicated", async () => {
    const page1 = [repo("1", "a"), repo("2", "b")];
    // "2" repeats on page 2 (e.g. GitHub's own sort shifted between
    // requests) — the hook must not show it twice.
    const page2 = [repo("2", "b"), repo("3", "c")];
    installPagedFetchMock([page1, page2]);

    const { result } = renderHook(() => useGithubRepositories(true));

    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.repos.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  test("search matches repository name, owner, and full name — case-insensitively", async () => {
    const page1 = [
      repo("1", "DeploymentPlatformInstaller", "MNIKevin202"),
      repo("2", "roadmap-studio", "other-owner")
    ];
    installPagedFetchMock([page1]);

    const { result } = renderHook(() => useGithubRepositories(true));
    await waitFor(() => expect(result.current.complete).toBe(true));

    act(() => result.current.setSearchQuery("installer"));
    await waitFor(() =>
      expect(result.current.filteredRepos.map((r) => r.id)).toEqual(["1"])
    );

    act(() => result.current.setSearchQuery("MNIKEVIN202"));
    await waitFor(() =>
      expect(result.current.filteredRepos.map((r) => r.id)).toEqual(["1"])
    );

    act(() => result.current.setSearchQuery("other-owner/roadmap-studio"));
    await waitFor(() =>
      expect(result.current.filteredRepos.map((r) => r.id)).toEqual(["2"])
    );
  });

  test("clearing search restores the complete repository list", async () => {
    const page1 = [repo("1", "a"), repo("2", "b")];
    installPagedFetchMock([page1]);

    const { result } = renderHook(() => useGithubRepositories(true));
    await waitFor(() => expect(result.current.complete).toBe(true));

    act(() => result.current.setSearchQuery("a"));
    await waitFor(() => expect(result.current.filteredRepos.length).toBe(1));

    act(() => result.current.setSearchQuery(""));
    await waitFor(() => expect(result.current.filteredRepos.length).toBe(2));
  });

  test("refresh clears stale pagination state and fetches all pages again", async () => {
    const firstRun = [[repo("1", "old-repo")]];
    const { impl } = installPagedFetchMock(firstRun);

    const { result } = renderHook(() => useGithubRepositories(true));
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.repos.map((r) => r.id)).toEqual(["1"]);

    // Simulate the repository set changing on GitHub's side between the
    // first load and the refresh (e.g. the operator granted access to a
    // new repo, or renamed one) — refresh must show the NEW set, not
    // merge with the stale one.
    vi.unstubAllGlobals();
    installPagedFetchMock([[repo("2", "new-repo")]]);

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.complete).toBe(true));
    await waitFor(() => expect(result.current.repos.map((r) => r.id)).toEqual(["2"]));
    expect(impl).toBeDefined();
  });

  test("loading, empty, no-results, and error states are distinct", async () => {
    // Loading: nothing loaded yet, request in flight.
    let resolvePage: ((value: Response) => void) | null = null;
    const impl = vi.fn(async () => {
      return new Promise<Response>((resolve) => {
        resolvePage = resolve;
      });
    });
    vi.stubGlobal("fetch", impl);

    const { result, rerender } = renderHook(({ enabled }) => useGithubRepositories(enabled), {
      initialProps: { enabled: true }
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.complete).toBe(false);
    expect(result.current.error).toBe("");

    resolvePage!(jsonResponse(200, { success: true, repositories: [], hasMore: false, source: "installation" }));
    await waitFor(() => expect(result.current.complete).toBe(true));

    // Empty: zero repositories accessible at all.
    expect(result.current.repos.length).toBe(0);
    expect(result.current.error).toBe("");

    // No-results: repos exist, but the search matches none of them.
    vi.unstubAllGlobals();
    installPagedFetchMock([[repo("1", "only-repo")]]);
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.setSearchQuery("does-not-exist-anywhere"));
    await waitFor(() => expect(result.current.filteredRepos.length).toBe(0));
    expect(result.current.repos.length).toBe(1);

    // Error: a GitHub connection failure produces a distinct error state.
    vi.unstubAllGlobals();
    const errorImpl = vi.fn(async () =>
      jsonResponse(409, { success: false, message: "GitHub is not connected." })
    );
    vi.stubGlobal("fetch", errorImpl);
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.error).toBe("GitHub is not connected."));
    expect(result.current.complete).toBe(false);
  });

  test("a 429 response sets a distinct rate-limited state, not a generic error", async () => {
    const impl = vi.fn(async () => jsonResponse(429, {}));
    vi.stubGlobal("fetch", impl);

    const { result } = renderHook(() => useGithubRepositories(true));

    await waitFor(() => expect(result.current.rateLimited).toBe(true));
    expect(result.current.error).toBe("");
  });

  test("never sends an Authorization header or token — all GitHub auth stays server-side", async () => {
    const impl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return jsonResponse(200, { success: true, repositories: [], hasMore: false, source: "installation" });
    });
    vi.stubGlobal("fetch", impl);

    const { result } = renderHook(() => useGithubRepositories(true));
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(impl).toHaveBeenCalled();
  });

  test("reset clears loaded repositories and search without making a request", async () => {
    installPagedFetchMock([[repo("1", "a")]]);

    const { result } = renderHook(() => useGithubRepositories(true));
    await waitFor(() => expect(result.current.complete).toBe(true));

    vi.unstubAllGlobals();
    const impl = vi.fn(async () => {
      throw new Error("reset() must not trigger a fetch");
    });
    vi.stubGlobal("fetch", impl);

    act(() => {
      result.current.setSearchQuery("a");
      result.current.reset();
    });

    expect(result.current.repos.length).toBe(0);
    expect(result.current.searchQuery).toBe("");
    expect(result.current.complete).toBe(false);
    expect(impl).not.toHaveBeenCalled();
  });

  test("disabled (enabled=false) never fetches", async () => {
    const impl = vi.fn();
    vi.stubGlobal("fetch", impl);

    renderHook(() => useGithubRepositories(false));

    expect(impl).not.toHaveBeenCalled();
  });
});
