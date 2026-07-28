import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiError, GithubRepositoriesResponse, SourceRepository } from "../types/api";

// The largest per-page value the API accepts (routes/github.ts's
// repositoriesQuerySchema) — requesting the max on every page minimizes
// the number of round trips needed to reach the end of a large
// installation.
const PER_PAGE = 50;

// A safety valve, not a real limit: this only ever fires against a
// misbehaving API (hasMore stuck at true forever), never a legitimate
// installation. 400 pages * 50/page = 20,000 repositories.
const MAX_PAGES = 400;

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

function matchesSearch(repo: SourceRepository, needle: string): boolean {
  return (
    repo.name.toLowerCase().includes(needle) ||
    repo.fullName.toLowerCase().includes(needle) ||
    repo.owner.toLowerCase().includes(needle)
  );
}

export interface UseGithubRepositoriesResult {
  /** The complete, deduplicated set of repositories loaded so far, in stable arrival order. */
  repos: SourceRepository[];
  /** `repos` filtered by `searchQuery` — name, full name, or owner, case-insensitive. */
  filteredRepos: SourceRepository[];
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  /** True only while the first page of a load/refresh is in flight — nothing has been shown yet. */
  loading: boolean;
  /** True while a later page is being fetched — some repositories are already visible. */
  loadingMore: boolean;
  /** True once every page GitHub reported has been fetched (or the safety cap was hit). */
  complete: boolean;
  error: string;
  rateLimited: boolean;
  /** Which credential the list came from — "installation" (GitHub App) or "pat" (advanced fallback). */
  source: "installation" | "pat" | undefined;
  /** Restarts pagination from page 1, discarding whatever was loaded before. */
  refresh: () => void;
  /** Clears whatever has been loaded without starting a new fetch — for an immediate UI clear after disconnecting. */
  reset: () => void;
}

/**
 * Loads the COMPLETE set of repositories accessible through
 * /api/integrations/github/repositories, following GitHub's pagination
 * (via the API's own `hasMore`, itself derived from GitHub's Link header)
 * until the final page, deduplicating by id, and exposing a single search
 * filter over the fully-loaded collection.
 *
 * Shared by RepositoriesPage and CreateAppWizard so both surfaces load,
 * refresh, and search repositories identically instead of maintaining two
 * separate pagination implementations.
 *
 * No GitHub token, installation token, or credential ever passes through
 * this hook or the component tree above it — every request goes to this
 * platform's own API, which resolves and uses the credential entirely
 * server-side (see github-token-service.ts).
 */
export function useGithubRepositories(enabled: boolean): UseGithubRepositoriesResult {
  const [repos, setRepos] = useState<SourceRepository[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [rateLimited, setRateLimited] = useState(false);
  const [source, setSource] = useState<"installation" | "pat" | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState("");

  // Bumped on every load/refresh so a stale in-flight pagination loop
  // (e.g. one abandoned by a Refresh click) can detect it is no longer
  // the current one and stop writing into state, instead of racing a
  // newer load and leaving stale/partial results visible.
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setRepos([]);
    setComplete(false);
    setError("");
    setRateLimited(false);
    setSource(undefined);
    setLoading(true);
    setLoadingMore(false);

    const seen = new Map<string, SourceRepository>();
    let page = 1;

    try {
      for (; page <= MAX_PAGES; page += 1) {
        const params = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE) });
        const response = await fetch(`/api/integrations/github/repositories?${params.toString()}`);

        if (generationRef.current !== generation) {
          // A newer load (refresh, or a second mount) has taken over —
          // abandon this loop's results silently rather than racing it.
          return;
        }

        if (response.status === 429) {
          setRateLimited(true);
          return;
        }

        if (!response.ok) {
          throw new Error(await readApiError(response, "Unable to load repositories"));
        }

        const result = (await response.json()) as GithubRepositoriesResponse;

        for (const repo of result.repositories) {
          if (!seen.has(repo.id)) {
            seen.set(repo.id, repo);
          }
        }

        setRepos(Array.from(seen.values()));
        setSource(result.source);

        if (page === 1) {
          setLoading(false);
          setLoadingMore(true);
        }

        if (!result.hasMore) {
          setComplete(true);
          return;
        }
      }
      // The safety cap was hit without GitHub ever reporting a final
      // page — treat what has been loaded as the final, usable result
      // rather than looping forever.
      setComplete(true);
    } catch (loadError) {
      if (generationRef.current === generation) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load repositories");
      }
    } finally {
      if (generationRef.current === generation) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  const reset = useCallback(() => {
    // Abandon any in-flight pagination loop so its later responses can't
    // repopulate state after this explicit clear.
    generationRef.current += 1;
    setRepos([]);
    setComplete(false);
    setLoading(false);
    setLoadingMore(false);
    setError("");
    setRateLimited(false);
    setSource(undefined);
    setSearchQuery("");
  }, []);

  useEffect(() => {
    if (enabled) {
      void load();
    } else {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const filteredRepos = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) {
      return repos;
    }
    return repos.filter((repo) => matchesSearch(repo, needle));
  }, [repos, searchQuery]);

  return {
    repos,
    filteredRepos,
    searchQuery,
    setSearchQuery,
    loading,
    loadingMore,
    complete,
    error,
    rateLimited,
    source,
    refresh,
    reset
  };
}
