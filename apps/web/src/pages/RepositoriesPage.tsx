import { useCallback, useEffect, useMemo, useState } from "react";
import GitHubSettingsPanel from "../components/GitHubSettingsPanel";
import GithubAppConnectPanel from "../components/GithubAppConnectPanel";
import { useGithubRepositories } from "../hooks/useGithubRepositories";
import type { GithubAppInstallation, GithubConnectionInfo } from "../types/api";

interface RepositoriesPageProps {
  onSelectRepository: (owner: string, name: string) => void;
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

/**
 * Reads and clears the ?section=repositories&github=connected|error|pending
 * query the GitHub App callback (routes/github-app.ts) redirects to, so a
 * page refresh afterward doesn't re-show a stale result. Read exactly once
 * per mount.
 */
function consumeGithubCallbackResult(): { status: string; message: string | null; installation: string | null } | null {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("github");

  if (!status) {
    return null;
  }

  const message = params.get("message");
  const installation = params.get("installation");

  params.delete("github");
  params.delete("message");
  params.delete("installation");
  params.delete("section");
  const remaining = params.toString();
  window.history.replaceState(null, "", remaining ? `?${remaining}` : window.location.pathname);

  return { status, message, installation };
}

export default function RepositoriesPage({ onSelectRepository }: RepositoriesPageProps) {
  const [connection, setConnection] = useState<GithubConnectionInfo | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);

  const [installations, setInstallations] = useState<GithubAppInstallation[]>([]);
  const [githubAppConfigured, setGithubAppConfigured] = useState(false);
  const [githubAppMissing, setGithubAppMissing] = useState<string[]>([]);

  const [callbackNotice, setCallbackNotice] = useState("");
  const [callbackError, setCallbackError] = useState("");

  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");

  const loadInstallations = useCallback(async () => {
    try {
      const response = await fetch("/api/github/installations");
      if (!response.ok) return;
      const result = (await response.json()) as {
        configured: boolean;
        missing?: string[];
        installations: GithubAppInstallation[];
      };
      setGithubAppConfigured(result.configured);
      setGithubAppMissing(result.missing ?? []);
      setInstallations(result.installations);
    } catch {
      // Non-fatal — the connect panel simply shows "not connected".
    }
  }, []);

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
    void loadInstallations();
  }, [loadConnection, loadInstallations]);

  useEffect(() => {
    const result = consumeGithubCallbackResult();
    if (!result) return;

    if (result.status === "connected") {
      setCallbackNotice(
        result.installation
          ? `GitHub connected (installation #${result.installation}). Repositories appear below.`
          : "GitHub connected. Repositories appear below."
      );
      void loadInstallations();
    } else if (result.status === "pending") {
      setCallbackNotice(result.message ?? "Installation is awaiting approval.");
    } else {
      setCallbackError(result.message ?? "Unable to complete GitHub authorization.");
    }
  }, [loadInstallations]);

  const connectedViaApp = installations.length > 0;
  const connectedViaPat = connection?.connected ?? false;

  // The shared loader walks every page automatically — see
  // useGithubRepositories.ts — so `repos` here is always the complete,
  // deduplicated collection (never just whatever page happened to be
  // loaded), and both filters below apply against all of it, not just a
  // partially-loaded subset.
  const {
    repos,
    loading,
    loadingMore,
    complete,
    error,
    rateLimited,
    refresh: refreshRepos,
    reset: resetRepos
  } = useGithubRepositories(connectedViaApp || connectedViaPat);

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
      {callbackNotice && <div className="notice-banner">{callbackNotice}</div>}
      {callbackError && <div className="error-banner">{callbackError}</div>}

      <section className="page-section">
        <GithubAppConnectPanel
          configured={githubAppConfigured}
          missing={githubAppMissing}
          installations={installations}
          repositoryCount={connectedViaApp ? repos.length : null}
          onDisconnected={() => {
            void loadInstallations();
            resetRepos();
          }}
          onRefreshRepositories={refreshRepos}
          refreshing={loading}
        />

        <details className="advanced-disclosure">
          <summary>Advanced: connect with a fine-grained personal access token</summary>
          <GitHubSettingsPanel onConnectionChanged={() => void loadConnection()} />
        </details>
      </section>

      {(connectedViaApp || connectedViaPat) && (
        <section className="page-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Repositories</p>
              <h2>Accessible GitHub Repositories</h2>
              {complete && repos.length > 0 && (
                <p className="text-faint">
                  {repos.length} repositor{repos.length === 1 ? "y" : "ies"} loaded
                </p>
              )}
            </div>
            <button
              className="secondary-button compact"
              type="button"
              onClick={refreshRepos}
              disabled={loading}
            >
              Refresh
            </button>
          </div>

          <div className="repo-filter-row">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search all repositories by name..."
            />
            <input
              value={ownerFilter}
              onChange={(event) => setOwnerFilter(event.target.value)}
              placeholder="Filter all repositories by owner..."
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
                ? "No accessible repositories were found."
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

          {loadingMore && (
            <p className="text-faint">Loading more repositories...</p>
          )}
        </section>
      )}
    </div>
  );
}
