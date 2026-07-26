import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiError,
  AppSourceInfo,
  AppSourceResponse,
  DeploymentMode,
  GithubBranchesResponse,
  GithubConnectionInfo,
  GithubRepositoriesResponse,
  SourceBranch,
  SourceRepository
} from "../types/api";
import StatusBadge from "./StatusBadge";
import ConfirmationDialog from "./ConfirmationDialog";

interface SourcePanelProps {
  appId: number;
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
    return "Never";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

interface DisplayState {
  label: string;
  tone: "positive" | "negative" | "neutral" | "warning";
}

function deriveDisplayState(
  source: AppSourceInfo | null,
  connection: GithubConnectionInfo | null
): DisplayState {
  if (!source) {
    return { label: "No repository linked", tone: "neutral" };
  }

  if (!connection?.connected) {
    return { label: "GitHub connection required", tone: "warning" };
  }

  if (source.validationStatus === "unknown") {
    return { label: "Validation stale", tone: "warning" };
  }

  if (source.validationStatus === "valid") {
    return { label: "Repository linked and valid", tone: "positive" };
  }

  const err = (source.validationError ?? "").toLowerCase();

  if (err.includes("not connected") || err.includes("credential")) {
    return { label: "Credential unavailable", tone: "negative" };
  }

  if (err.includes("dockerfile not found")) {
    return { label: "Dockerfile missing", tone: "negative" };
  }

  if (err.includes("not found")) {
    return { label: "Repository or branch inaccessible", tone: "negative" };
  }

  return { label: "Validation failed", tone: "negative" };
}

export default function SourcePanel({ appId }: SourcePanelProps) {
  const [source, setSource] = useState<AppSourceInfo | null>(null);
  const [connection, setConnection] = useState<GithubConnectionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [validating, setValidating] = useState(false);

  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [showLinkDialog, setShowLinkDialog] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError("");

      const [sourceResponse, connectionResponse] = await Promise.all([
        fetch(`/api/apps/${appId}/source`),
        fetch("/api/integrations/github")
      ]);

      if (!sourceResponse.ok) {
        throw new Error(await readApiError(sourceResponse, "Unable to load source configuration"));
      }

      const sourceResult = (await sourceResponse.json()) as AppSourceResponse;
      setSource(sourceResult.source);

      if (connectionResponse.ok) {
        setConnection((await connectionResponse.json()) as GithubConnectionInfo);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load source configuration");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runValidateAgain = async () => {
    try {
      setValidating(true);
      setActionError("");
      setNotice("");

      const response = await fetch(`/api/apps/${appId}/source/validate`, { method: "POST" });
      const result = (await response.json().catch(() => ({}))) as Partial<AppSourceResponse>;

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to validate source");
      }

      setSource(result.source ?? null);
      setNotice(
        result.source?.validationStatus === "valid"
          ? "Validation succeeded."
          : "Validation failed — see the details below."
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to validate source");
    } finally {
      setValidating(false);
    }
  };

  const confirmRemove = async () => {
    try {
      setRemoving(true);

      const response = await fetch(`/api/apps/${appId}/source`, { method: "DELETE" });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to remove source"));
      }

      setShowRemoveConfirm(false);
      setSource(null);
      setNotice("Source link removed.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to remove source");
      setShowRemoveConfirm(false);
    } finally {
      setRemoving(false);
    }
  };

  if (loading && !source) {
    return <div className="empty-state">Loading source configuration...</div>;
  }

  if (loadError) {
    return <div className="error-banner">{loadError}</div>;
  }

  const display = deriveDisplayState(source, connection);

  return (
    <div className="app-detail-tab-panel">
      {actionError && <div className="error-banner">{actionError}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="env-scope-block">
        <div className="env-scope-heading">
          <h3>Source</h3>
          <StatusBadge label={display.label} tone={display.tone} />
        </div>

        {!connection?.connected && (
          <div className="warning-banner">
            GitHub is not connected. Connect it from the Repositories section before linking or
            validating a source.
          </div>
        )}

        {!source ? (
          <div className="empty-state">
            No repository is linked to this app yet.
            <div className="form-actions form-actions-start">
              <button
                className="primary-button compact"
                type="button"
                onClick={() => setShowLinkDialog(true)}
              >
                Link Repository
              </button>
            </div>
          </div>
        ) : (
          <>
            <dl className="wizard-review-grid">
              <div>
                <dt>Provider</dt>
                <dd>GitHub</dd>
              </div>
              <div>
                <dt>Repository</dt>
                <dd>
                  {source.repositoryOwner}/{source.repositoryName}
                </dd>
              </div>
              <div>
                <dt>Visibility</dt>
                <dd>{source.repositoryVisibility ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>{source.branch}</dd>
              </div>
              <div>
                <dt>Deployment mode</dt>
                <dd>{source.deploymentMode}</dd>
              </div>
              {source.deploymentMode === "dockerfile" && (
                <>
                  <div>
                    <dt>Dockerfile path</dt>
                    <dd>
                      <code>{source.dockerfilePath}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Build context</dt>
                    <dd>
                      <code>{source.buildContext}</code>
                    </dd>
                  </div>
                </>
              )}
              <div>
                <dt>Auto deploy</dt>
                <dd>{source.autoDeploy ? "Enabled" : "Disabled"} (coming in a later phase)</dd>
              </div>
              <div>
                <dt>Current validated commit</dt>
                <dd title={source.lastValidatedCommitSha ?? undefined}>
                  <code>{shortSha(source.lastValidatedCommitSha)}</code>
                </dd>
              </div>
              <div>
                <dt>Last validated</dt>
                <dd>{formatDate(source.lastValidatedAt)}</dd>
              </div>
              <div>
                <dt>Validation status</dt>
                <dd>{source.validationStatus}</dd>
              </div>
            </dl>

            {source.validationError && (
              <p className="section-description">
                Validation error: <code>{source.validationError}</code>
              </p>
            )}

            <div className="container-actions">
              <a
                className="secondary-button compact"
                href={`https://github.com/${source.repositoryOwner}/${source.repositoryName}`}
                target="_blank"
                rel="noreferrer"
              >
                Open on GitHub
              </a>
              <button
                className="secondary-button compact"
                type="button"
                onClick={() => void runValidateAgain()}
                disabled={validating}
              >
                {validating ? "Validating..." : "Validate Again"}
              </button>
              <button
                className="secondary-button compact"
                type="button"
                onClick={() => setShowLinkDialog(true)}
              >
                Change Source
              </button>
              <button
                className="danger-button compact"
                type="button"
                onClick={() => setShowRemoveConfirm(true)}
              >
                Remove Source
              </button>
            </div>
          </>
        )}
      </div>

      {showLinkDialog && (
        <LinkRepositoryDialog
          appId={appId}
          existing={source}
          onClose={() => setShowLinkDialog(false)}
          onSaved={(saved) => {
            setSource(saved);
            setShowLinkDialog(false);
            setNotice("Source configuration saved.");
          }}
        />
      )}

      <ConfirmationDialog
        open={showRemoveConfirm}
        title="Remove source link?"
        message={
          <p>
            This removes the repository link from this app. Nothing on GitHub is affected, and the
            app itself keeps running as configured.
          </p>
        }
        confirmLabel="Remove source"
        danger
        confirming={removing}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setShowRemoveConfirm(false)}
      />
    </div>
  );
}

interface LinkRepositoryDialogProps {
  appId: number;
  existing: AppSourceInfo | null;
  onClose: () => void;
  onSaved: (source: AppSourceInfo) => void;
}

type WizardStep = "provider" | "repository" | "branch" | "mode" | "review";

const STEP_ORDER: WizardStep[] = ["provider", "repository", "branch", "mode", "review"];
const STEP_LABELS: Record<WizardStep, string> = {
  provider: "Provider",
  repository: "Repository",
  branch: "Branch",
  mode: "Deployment",
  review: "Review"
};

function LinkRepositoryDialog({ appId, existing, onClose, onSaved }: LinkRepositoryDialogProps) {
  const [step, setStep] = useState<WizardStep>("provider");

  const [repos, setRepos] = useState<SourceRepository[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState("");
  const [search, setSearch] = useState("");

  const [selectedRepo, setSelectedRepo] = useState<SourceRepository | null>(null);

  const [branches, setBranches] = useState<SourceBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState("");
  const [selectedBranch, setSelectedBranch] = useState(existing?.branch ?? "");

  const [deploymentMode, setDeploymentMode] = useState<DeploymentMode>(
    existing?.deploymentMode ?? "prebuilt-image"
  );
  const [dockerfilePath, setDockerfilePath] = useState(existing?.dockerfilePath ?? "Dockerfile");
  const [buildContext, setBuildContext] = useState(existing?.buildContext ?? ".");
  const [autoDeploy, setAutoDeploy] = useState(existing?.autoDeploy ?? false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // GitHub's repository-listing endpoint has no name-search parameter, so
  // "search" only filters repositories already loaded into `repos` — it is
  // never sent to the server.
  const loadRepos = useCallback(async () => {
    try {
      setReposLoading(true);
      setReposError("");

      const params = new URLSearchParams({ page: "1", perPage: "20" });
      const response = await fetch(`/api/integrations/github/repositories?${params.toString()}`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load repositories"));
      }

      const result = (await response.json()) as GithubRepositoriesResponse;
      setRepos(result.repositories);
    } catch (error) {
      setReposError(error instanceof Error ? error.message : "Unable to load repositories");
    } finally {
      setReposLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step === "repository") {
      void loadRepos();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const visibleRepos = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? repos.filter((repo) => repo.fullName.toLowerCase().includes(needle)) : repos;
  }, [repos, search]);

  const loadBranches = useCallback(async (repo: SourceRepository) => {
    try {
      setBranchesLoading(true);
      setBranchesError("");

      const response = await fetch(
        `/api/integrations/github/repositories/${repo.owner}/${repo.name}/branches`
      );

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load branches"));
      }

      const result = (await response.json()) as GithubBranchesResponse;
      setBranches(result.branches);

      if (!result.branches.some((branch) => branch.name === selectedBranch)) {
        setSelectedBranch(repo.defaultBranch);
      }
    } catch (error) {
      setBranchesError(error instanceof Error ? error.message : "Unable to load branches");
    } finally {
      setBranchesLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectRepo = (repo: SourceRepository) => {
    setSelectedRepo(repo);
    setSelectedBranch(repo.defaultBranch);
    setStep("branch");
    void loadBranches(repo);
  };

  const goBack = () => {
    const index = STEP_ORDER.indexOf(step);
    if (index > 0) {
      setStep(STEP_ORDER[index - 1]);
    }
  };

  const goNext = () => {
    const index = STEP_ORDER.indexOf(step);
    if (index < STEP_ORDER.length - 1) {
      setStep(STEP_ORDER[index + 1]);
    }
  };

  const canContinue =
    step === "provider" ||
    (step === "repository" && selectedRepo !== null) ||
    (step === "branch" && selectedBranch.length > 0) ||
    (step === "mode" &&
      (deploymentMode === "prebuilt-image" || (dockerfilePath.length > 0 && buildContext.length > 0)));

  const submit = async () => {
    if (!selectedRepo) {
      return;
    }

    try {
      setSaving(true);
      setSaveError("");

      const response = await fetch(`/api/apps/${appId}/source`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryOwner: selectedRepo.owner,
          repositoryName: selectedRepo.name,
          branch: selectedBranch,
          deploymentMode,
          dockerfilePath,
          buildContext,
          autoDeploy
        })
      });

      const result = (await response.json().catch(() => ({}))) as Partial<AppSourceResponse>;

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to save source configuration");
      }

      if (result.source) {
        onSaved(result.source);
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save source configuration");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <section className="form-modal wizard-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">{existing ? "Change Source" : "Link Repository"}</p>
            <h2>Repository Source</h2>
          </div>
          <button className="close-button" type="button" disabled={saving} onClick={onClose}>
            Close
          </button>
        </header>

        <div className="wizard-steps">
          {STEP_ORDER.map((key, index) => (
            <div
              key={key}
              className={`wizard-step-item ${
                key === step ? "active" : STEP_ORDER.indexOf(step) > index ? "done" : ""
              }`}
            >
              <span className="wizard-step-index">
                {STEP_ORDER.indexOf(step) > index ? "✓" : index + 1}
              </span>
              <span>{STEP_LABELS[key]}</span>
            </div>
          ))}
        </div>

        <div className="wizard-body">
          {step === "provider" && (
            <>
              <p className="section-description">
                GitHub is the only supported provider in this phase. This platform never hosts or
                clones your repository — it only reads metadata needed to prepare a deployment.
              </p>
              <div className="wizard-row">
                <strong>GitHub</strong>
              </div>
            </>
          )}

          {step === "repository" && (
            <>
              <label>
                <span>Filter repositories</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter loaded repositories by name..."
                />
              </label>

              {reposError && <div className="error-banner">{reposError}</div>}

              {reposLoading ? (
                <div className="empty-state">Loading repositories...</div>
              ) : visibleRepos.length === 0 ? (
                <div className="empty-state">
                  {repos.length === 0 ? "No repositories found." : "No repositories match this filter."}
                </div>
              ) : (
                <div className="wizard-row-list">
                  {visibleRepos.map((repo) => (
                    <button
                      key={repo.id}
                      type="button"
                      className={`wizard-row repo-select-row ${selectedRepo?.id === repo.id ? "selected" : ""}`}
                      onClick={() => selectRepo(repo)}
                    >
                      <strong>{repo.fullName}</strong>
                      <span className="text-faint">{repo.private ? "Private" : "Public"} · default: {repo.defaultBranch}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {step === "branch" && selectedRepo && (
            <>
              <p className="section-description">
                Repository: <strong>{selectedRepo.fullName}</strong>
              </p>
              {branchesError && <div className="error-banner">{branchesError}</div>}
              {branchesLoading ? (
                <div className="empty-state">Loading branches...</div>
              ) : (
                <label>
                  <span>Branch</span>
                  <select
                    className="wizard-select"
                    value={selectedBranch}
                    onChange={(event) => setSelectedBranch(event.target.value)}
                  >
                    {branches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}

          {step === "mode" && (
            <>
              <label>
                <span>Deployment mode</span>
                <select
                  className="wizard-select"
                  value={deploymentMode}
                  onChange={(event) => setDeploymentMode(event.target.value as DeploymentMode)}
                >
                  <option value="prebuilt-image">Prebuilt image (unchanged deployment behavior)</option>
                  <option value="dockerfile">Dockerfile (build settings only — no builds yet)</option>
                </select>
              </label>

              {deploymentMode === "dockerfile" && (
                <>
                  <label>
                    <span>Dockerfile path</span>
                    <input
                      value={dockerfilePath}
                      onChange={(event) => setDockerfilePath(event.target.value)}
                      placeholder="Dockerfile"
                    />
                  </label>
                  <label>
                    <span>Build context</span>
                    <input
                      value={buildContext}
                      onChange={(event) => setBuildContext(event.target.value)}
                      placeholder="."
                    />
                  </label>
                </>
              )}

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={autoDeploy}
                  onChange={(event) => setAutoDeploy(event.target.checked)}
                />
                <span>Auto deploy on push — coming in a later phase (safe to enable now, has no effect yet)</span>
              </label>
            </>
          )}

          {step === "review" && selectedRepo && (
            <>
              <dl className="wizard-review-grid">
                <div>
                  <dt>Repository</dt>
                  <dd>{selectedRepo.fullName}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{selectedBranch}</dd>
                </div>
                <div>
                  <dt>Deployment mode</dt>
                  <dd>{deploymentMode}</dd>
                </div>
                {deploymentMode === "dockerfile" && (
                  <>
                    <div>
                      <dt>Dockerfile path</dt>
                      <dd>{dockerfilePath}</dd>
                    </div>
                    <div>
                      <dt>Build context</dt>
                      <dd>{buildContext}</dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>Auto deploy</dt>
                  <dd>{autoDeploy ? "Enabled (inactive this phase)" : "Disabled"}</dd>
                </div>
              </dl>
              <p className="section-description">
                Saving will validate this configuration against GitHub immediately (repository
                access, branch existence, and Dockerfile presence if applicable).
              </p>
              {saveError && <div className="error-banner">{saveError}</div>}
            </>
          )}
        </div>

        <div className="wizard-footer">
          <button
            className="secondary-button"
            type="button"
            disabled={step === "provider" || saving}
            onClick={goBack}
          >
            Back
          </button>

          <div className="wizard-footer-right">
            <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>
              Cancel
            </button>

            {step === "review" ? (
              <button className="primary-button" type="button" disabled={saving} onClick={() => void submit()}>
                {saving ? "Saving..." : "Save & Validate"}
              </button>
            ) : (
              <button className="primary-button" type="button" disabled={!canContinue} onClick={goNext}>
                Continue
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
