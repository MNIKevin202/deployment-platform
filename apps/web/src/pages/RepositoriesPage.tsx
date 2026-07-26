import { useCallback, useEffect, useMemo, useState } from "react";
import GitHubSettingsPanel from "../components/GitHubSettingsPanel";
import type { ApiError, GithubConnectionInfo, SourceRepository } from "../types/api";

interface RepositoriesPageProps {
  onSelectRepository: (owner: string, name: string) => void;
}

const PER_PAGE = 20;

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

function formatRelativeOrAbsolute(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const diffMs = Date.now() - parsed.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `Today (${parsed.toLocaleDateString()})`;
  }

  if (diffDays === 1) {
    return `Yesterday (${parsed.toLocaleDateString()})`;
  }

  if (diffDays < 30) {
    return `${diffDays} days ago (${parsed.toLocaleDateString()})`;
  }

  return parsed.toLocaleDateString();
}

export default function RepositoriesPage({ onSelectRepository }: RepositoriesPageProps) {
  const [connection, setConnection] = useState<GithubConnectionInfo | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);

  const [repos, setRepos] = useState<SourceRepository[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [rateLimited, setRateLimited] = useState(false);

  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");

  const loadConnection = useCallback(async () => {
    try {
      setConnectionLoading(true);
      const response = await fetch("/api/integrations/github");

      if (response.ok) {
        setConnection((await response.json()) as GithubConnectionInfo);
      }
    } catch {
      // Handled by the settings panel's own error state — this page only
      // needs to know whether to show the repository browser at all.
    } finally {
      setConnectionLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnection();
  }, [loadConnection]);

  // GitHub's repository-listing endpoint has no name-search parameter, so
  // "search" here only ever filters repositories that have already been
  // loaded into `repos` — it is not sent to the server. Load More expands
  // the set available to search/filter over.
  const loadRepos = useCallback(async (targetPage: number, append: boolean) => {
    try {
      append ? setLoadingMore(true) : setLoading(true);
      setError("");
      setRateLimited(false);

      const params = new URLSearchParams({
        page: String(targetPage),
        perPage: String(PER_PAGE)
      });

      const response = await fetch(`/api/integrations/github/repositories?${params.toString()}`);

      if (response.status === 429) {
        setRateLimited(true);
        return;
      }

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load repositories"));
      }

      const result = (await response.json()) as { repositories: SourceRepository[]; hasMore: boolean };

      setRepos((current) => (append ? [...current, ...result.repositories] : result.repositories));
      setHasMore(result.hasMore);
      setPage(targetPage);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load repositories");
    } finally {
      append ? setLoadingMore(false) : setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connection?.connected) {
      void loadRepos(1, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.connected]);

  const visibleRepos = useMemo(() => {
    const searchNeedle = search.trim().toLowerCase();
    const ownerNeedle = ownerFilter.trim().toLowerCase();

    return repos.filter((repo) => {
      const matchesSearch = !searchNeedle || repo.fullName.toLowerCase().includes(searchNeedle);
      const matchesOwner = !ownerNeedle || repo.owner.toLowerCase().includes(ownerNeedle);
      return matchesSearch && matchesOwner;
    });
  }, [repos, search, ownerFilter]);

  if (connectionLoading) {
    return <div className="page empty-state">Loading GitHub integration...</div>;
  }

  return (
    <div className="page">
      <section className="page-section">
        <GitHubSettingsPanel onConnectionChanged={() => void loadConnection()} />
      </section>

      {connection?.connected && (
        <section className="page-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Repositories</p>
              <h2>Accessible GitHub Repositories</h2>
            </div>
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => void loadRepos(1, false)}
              disabled={loading}
            >
              Refresh
            </button>
          </div>

          <div className="repo-filter-row">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter loaded repositories by name..."
            />
            <input
              value={ownerFilter}
              onChange={(event) => setOwnerFilter(event.target.value)}
              placeholder="Filter loaded repositories by owner..."
            />
          </div>

          {error && <div className="error-banner">{error}</div>}
          {rateLimited && (
            <div className="warning-banner">
              GitHub's rate limit was reached. Try refreshing again shortly.
            </div>
          )}

          {loading ? (
            <div className="empty-state">Loading repositories...</div>
          ) : visibleRepos.length === 0 ? (
            <div className="empty-state">
              {repos.length === 0
                ? "No accessible repositories were found for this token."
                : "No repositories match this filter."}
            </div>
          ) : (
            <div className="repo-grid">
              {visibleRepos.map((repo) => (
                <article className="repo-card" key={repo.id}>
                  <div className="repo-card-header">
                    <button
                      className="repo-card-title"
                      type="button"
                      onClick={() => onSelectRepository(repo.owner, repo.name)}
                    >
                      {repo.fullName}
                    </button>
                    <div className="repo-card-badges">
                      <span className={`status-badge compact ${repo.private ? "warning" : "neutral"}`}>
                        {repo.private ? "Private" : "Public"}
                      </span>
                      {repo.archived && <span className="status-badge compact negative">Archived</span>}
                    </div>
                  </div>

                  {repo.description && <p className="repo-card-description">{repo.description}</p>}

                  <dl className="repo-card-meta">
                    <div>
                      <dt>Default branch</dt>
                      <dd>{repo.defaultBranch}</dd>
                    </div>
                    <div>
                      <dt>Last pushed</dt>
                      <dd>{formatRelativeOrAbsolute(repo.pushedAt)}</dd>
                    </div>
                  </dl>

                  <div className="container-actions">
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={() => onSelectRepository(repo.owner, repo.name)}
                    >
                      View Details
                    </button>
                    <a
                      className="secondary-button compact"
                      href={repo.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open on GitHub
                    </a>
                  </div>
                </article>
              ))}
            </div>
          )}

          {hasMore && !loading && (
            <div className="form-actions form-actions-start">
              <button
                className="secondary-button"
                type="button"
                onClick={() => void loadRepos(page + 1, true)}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading..." : "Load More"}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
