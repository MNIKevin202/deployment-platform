import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  AppSourceInfo,
  GithubBranchesResponse,
  GithubCommitsResponse,
  GithubRepositoryResponse,
  SourceBranch,
  SourceCommit,
  SourceRepository,
  StoredApp,
  StoredAppsResponse
} from "../types/api";

interface RepositoryDetailProps {
  owner: string;
  name: string;
  onBack: () => void;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export default function RepositoryDetail({ owner, name, onBack }: RepositoryDetailProps) {
  const [repo, setRepo] = useState<SourceRepository | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [branches, setBranches] = useState<SourceBranch[]>([]);
  const [branchesError, setBranchesError] = useState("");
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  const [commits, setCommits] = useState<SourceCommit[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState("");

  const [linkedApps, setLinkedApps] = useState<Array<{ app: StoredApp; source: AppSourceInfo }>>([]);
  const [linkedAppsLoading, setLinkedAppsLoading] = useState(true);

  const loadRepo = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const [repoResponse, branchesResponse] = await Promise.all([
        fetch(`/api/integrations/github/repositories/${owner}/${name}`),
        fetch(`/api/integrations/github/repositories/${owner}/${name}/branches`)
      ]);

      if (!repoResponse.ok) {
        throw new Error(await readApiError(repoResponse, "Unable to load this repository"));
      }

      const repoResult = (await repoResponse.json()) as GithubRepositoryResponse;
      setRepo(repoResult.repository ?? null);
      setSelectedBranch(repoResult.repository?.defaultBranch ?? null);

      if (branchesResponse.ok) {
        const branchesResult = (await branchesResponse.json()) as GithubBranchesResponse;
        setBranches(branchesResult.branches);
      } else {
        setBranchesError(await readApiError(branchesResponse, "Unable to load branches"));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load this repository");
    } finally {
      setLoading(false);
    }
  }, [owner, name]);

  useEffect(() => {
    void loadRepo();
  }, [loadRepo]);

  const loadCommits = useCallback(
    async (branch: string) => {
      try {
        setCommitsLoading(true);
        setCommitsError("");

        const response = await fetch(
          `/api/integrations/github/repositories/${owner}/${name}/commits?branch=${encodeURIComponent(branch)}&perPage=10`
        );

        if (!response.ok) {
          throw new Error(await readApiError(response, "Unable to load commits"));
        }

        const result = (await response.json()) as GithubCommitsResponse;
        setCommits(result.commits);
      } catch (loadError) {
        setCommitsError(loadError instanceof Error ? loadError.message : "Unable to load commits");
      } finally {
        setCommitsLoading(false);
      }
    },
    [owner, name]
  );

  useEffect(() => {
    if (selectedBranch) {
      void loadCommits(selectedBranch);
    }
  }, [selectedBranch, loadCommits]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        setLinkedAppsLoading(true);

        const appsResponse = await fetch("/api/apps");
        if (!appsResponse.ok) {
          return;
        }

        const appsResult = (await appsResponse.json()) as StoredAppsResponse;

        const withSources = await Promise.all(
          appsResult.apps.map(async (app) => {
            const sourceResponse = await fetch(`/api/apps/${app.id}/source`);
            if (!sourceResponse.ok) {
              return null;
            }
            const sourceResult = (await sourceResponse.json()) as { source: AppSourceInfo | null };
            return sourceResult.source ? { app, source: sourceResult.source } : null;
          })
        );

        if (!cancelled) {
          setLinkedApps(
            withSources.filter(
              (entry): entry is { app: StoredApp; source: AppSourceInfo } =>
                entry !== null &&
                entry.source.repositoryOwner.toLowerCase() === owner.toLowerCase() &&
                entry.source.repositoryName.toLowerCase() === name.toLowerCase()
            )
          );
        }
      } finally {
        if (!cancelled) {
          setLinkedAppsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [owner, name]);

  return (
    <div className="page">
      <button className="secondary-button" type="button" onClick={onBack}>
        Back to Repositories
      </button>

      {loading ? (
        <div className="empty-state">Loading repository...</div>
      ) : error ? (
        <div className="error-banner">{error}</div>
      ) : !repo ? (
        <div className="empty-state">Repository not found.</div>
      ) : (
        <>
          <section className="page-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Repository</p>
                <h2>{repo.fullName}</h2>
              </div>
              <a className="secondary-button compact" href={repo.htmlUrl} target="_blank" rel="noreferrer">
                Open on GitHub
              </a>
            </div>

            {repo.description && <p className="section-description">{repo.description}</p>}

            <dl className="wizard-review-grid">
              <div>
                <dt>Visibility</dt>
                <dd>{repo.private ? "Private" : "Public"}</dd>
              </div>
              <div>
                <dt>Default branch</dt>
                <dd>{repo.defaultBranch}</dd>
              </div>
              <div>
                <dt>Archived</dt>
                <dd>{repo.archived ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt>Last pushed</dt>
                <dd>{formatDate(repo.pushedAt)}</dd>
              </div>
            </dl>
          </section>

          <section className="page-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Branch</p>
                <h2>Recent Branches &amp; Commits</h2>
              </div>
            </div>

            {branchesError && <div className="error-banner">{branchesError}</div>}

            <label>
              <span>Branch</span>
              <select
                className="wizard-select"
                value={selectedBranch ?? ""}
                onChange={(event) => setSelectedBranch(event.target.value)}
              >
                {branches.map((branch) => (
                  <option key={branch.name} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>

            {commitsError && <div className="error-banner">{commitsError}</div>}

            {commitsLoading ? (
              <div className="empty-state">Loading commits...</div>
            ) : commits.length === 0 ? (
              <div className="empty-state">No commits found on this branch.</div>
            ) : (
              <div className="table-wrap">
                <table className="env-table">
                  <thead>
                    <tr>
                      <th>Commit</th>
                      <th>Message</th>
                      <th>Author</th>
                      <th>Date</th>
                      <th aria-label="Link" />
                    </tr>
                  </thead>
                  <tbody>
                    {commits.map((commit) => (
                      <tr key={commit.sha}>
                        <td>
                          <code title={commit.sha}>{shortSha(commit.sha)}</code>
                        </td>
                        <td>{commit.message.split("\n")[0]}</td>
                        <td>{commit.authorName ?? "Unknown"}</td>
                        <td className="text-faint">{formatDate(commit.authorDate)}</td>
                        <td className="env-actions-cell">
                          <a
                            className="secondary-button compact"
                            href={commit.htmlUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="page-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Usage</p>
                <h2>Linked Applications</h2>
              </div>
            </div>

            {linkedAppsLoading ? (
              <div className="empty-state">Checking linked applications...</div>
            ) : linkedApps.length === 0 ? (
              <div className="empty-state">No managed app currently links to this repository.</div>
            ) : (
              <ul className="linked-apps-list">
                {linkedApps.map(({ app, source }) => (
                  <li key={app.id}>
                    <strong>{app.name}</strong> — {source.branch} ({source.deploymentMode})
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
