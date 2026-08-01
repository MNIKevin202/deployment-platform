import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiError,
  AppSourceInfo,
  AppSourceResponse,
  AutoDeployResponse,
  BuildStrategy,
  DeploymentMode,
  GithubBranchesResponse,
  GithubCommitsResponse,
  GithubConnectionInfo,
  GithubDeployResponse,
  GithubDeployStatusResponse,
  GithubRepositoriesResponse,
  InspectSourceResponse,
  RepositoryInspectionResult,
  SourceBranch,
  SourceRepository
} from "../types/api";
import StatusBadge from "./StatusBadge";
import ConfirmationDialog from "./ConfirmationDialog";

export const PROJECT_TYPE_LABELS: Record<string, string> = {
  dockerfile: "Dockerfile project",
  nodejs: "Node.js",
  static: "Static site",
  "docker-compose": "Docker Compose (unsupported)",
  python: "Python (unsupported)",
  go: "Go (unsupported)",
  rust: "Rust (unsupported)",
  php: "PHP (unsupported)",
  ruby: "Ruby (unsupported)",
  java: "Java (unsupported)",
  unknown: "Unknown"
};

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

function deriveDisplayState(source: AppSourceInfo | null, githubUsable: boolean): DisplayState {
  if (!source) {
    return { label: "No repository linked", tone: "neutral" };
  }

  if (!githubUsable) {
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
  // GET /api/integrations/github only ever reflects the advanced/manual
  // PAT — it has no notion of a GitHub App installation. A GitHub App
  // installation is an equally valid, and now the PRIMARY, way to reach
  // GitHub (see github-token-service.ts's resolveGithubToken, which every
  // actual backend action here already uses). Checking installations here
  // too — the same pattern RepositoriesPage.tsx and CreateAppWizard.tsx
  // already use — is what makes this panel's "connected" indicator and
  // button-disabling agree with what the backend will actually do,
  // instead of falsely reporting "GitHub is not connected" whenever only
  // the GitHub App (not a PAT) is configured.
  const [githubAppInstalled, setGithubAppInstalled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [validating, setValidating] = useState(false);

  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [showLinkDialog, setShowLinkDialog] = useState(false);

  const [inspection, setInspection] = useState<RepositoryInspectionResult | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState("");

  const [deployInProgress, setDeployInProgress] = useState(false);
  const [showDeployConfirm, setShowDeployConfirm] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployNoCache, setDeployNoCache] = useState(false);
  const [deployError, setDeployError] = useState("");
  const [savingAutoDeploy, setSavingAutoDeploy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError("");

      const [sourceResponse, connectionResponse, installationsResponse] = await Promise.all([
        fetch(`/api/apps/${appId}/source`),
        fetch("/api/integrations/github"),
        fetch("/api/github/installations")
      ]);

      if (!sourceResponse.ok) {
        throw new Error(await readApiError(sourceResponse, "Unable to load source configuration"));
      }

      const sourceResult = (await sourceResponse.json()) as AppSourceResponse;
      setSource(sourceResult.source);

      if (connectionResponse.ok) {
        setConnection((await connectionResponse.json()) as GithubConnectionInfo);
      }

      if (installationsResponse.ok) {
        const installationsResult = (await installationsResponse.json()) as {
          installations: { installationId: number }[];
        };
        setGithubAppInstalled(installationsResult.installations.length > 0);
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

  useEffect(() => {
    let cancelled = false;

    async function pollStatus() {
      try {
        const response = await fetch(`/api/apps/${appId}/deploy/github/status`);
        if (!response.ok || cancelled) return;
        const result = (await response.json()) as GithubDeployStatusResponse;
        if (!cancelled) {
          setDeployInProgress(result.inProgress);
        }
      } catch {
        // Status polling is best-effort — a transient failure just means
        // the "in progress" indicator may lag by one interval.
      }
    }

    void pollStatus();
    const interval = setInterval(() => void pollStatus(), 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [appId]);

  const runInspect = async () => {
    try {
      setInspecting(true);
      setInspectError("");

      const response = await fetch(`/api/apps/${appId}/source/inspect`, { method: "POST" });
      const result = (await response.json().catch(() => ({}))) as Partial<InspectSourceResponse>;

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to inspect repository");
      }

      setInspection(result.inspection ?? null);
      await load();
    } catch (error) {
      setInspectError(error instanceof Error ? error.message : "Unable to inspect repository");
    } finally {
      setInspecting(false);
    }
  };

  const confirmDeploy = async () => {
    try {
      setDeploying(true);
      setDeployError("");

      const response = await fetch(`/api/apps/${appId}/deploy/github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // noCache is the operator's escape hatch for a corrupt Docker build
        // cache (the "parent snapshot does not exist" failure). Only sent
        // when ticked, so a normal deploy is unchanged.
        body: JSON.stringify(deployNoCache ? { noCache: true } : {})
      });

      const result = (await response.json().catch(() => ({}))) as Partial<GithubDeployResponse>;

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Deployment failed");
      }

      setShowDeployConfirm(false);
      setNotice(`Deployment succeeded (${result.commitSha ? result.commitSha.slice(0, 7) : "unknown commit"}).`);
      await load();
    } catch (error) {
      setDeployError(error instanceof Error ? error.message : "Deployment failed");
      setShowDeployConfirm(false);
    } finally {
      setDeploying(false);
    }
  };

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

  const toggleAutoDeploy = async (enabled: boolean) => {
    if (!source) {
      return;
    }

    try {
      setSavingAutoDeploy(true);
      setActionError("");

      const response = await fetch(`/api/apps/${appId}/source/auto-deploy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled })
      });

      const result = (await response.json().catch(() => null)) as
        | (AutoDeployResponse & { message?: string })
        | null;

      if (!response.ok || !result?.success) {
        throw new Error(result?.message || "Unable to update auto-deploy");
      }

      setSource((current) => (current ? { ...current, autoDeploy: enabled } : current));
      setNotice(
        enabled
          ? "Auto-deploy enabled — new commits on this branch will deploy automatically."
          : "Auto-deploy disabled."
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to update auto-deploy");
    } finally {
      setSavingAutoDeploy(false);
    }
  };

  if (loading && !source) {
    return <div className="empty-state">Loading source configuration...</div>;
  }

  if (loadError) {
    return <div className="error-banner">{loadError}</div>;
  }

  // Ready via either path — the automated GitHub App installation
  // (primary) or the advanced manual PAT (fallback) — matching the exact
  // logic github-token-service.ts's resolveGithubToken already uses
  // server-side for every actual action below.
  const githubUsable = githubAppInstalled || (connection?.connected ?? false);
  const display = deriveDisplayState(source, githubUsable);

  return (
    <div className="app-detail-tab-panel">
      {actionError && <div className="error-banner">{actionError}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="env-scope-block">
        <div className="env-scope-heading">
          <h3>Source</h3>
          <StatusBadge label={display.label} tone={display.tone} />
        </div>

        {!githubUsable && (
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
                <dt>Subdirectory</dt>
                <dd>
                  <code>{source.subdirectory}</code>
                </dd>
              </div>
              <div>
                <dt>Detected type</dt>
                <dd>
                  {source.detectedProjectType
                    ? PROJECT_TYPE_LABELS[source.detectedProjectType] ?? source.detectedProjectType
                    : "Not inspected yet"}
                </dd>
              </div>
              <div>
                <dt>Build strategy</dt>
                <dd>
                  {source.buildStrategy && source.buildStrategy !== "unsupported"
                    ? STRATEGY_INFO[source.buildStrategy].title
                    : source.buildStrategy === "unsupported"
                      ? "Unsupported"
                      : "Not inspected yet"}
                </dd>
              </div>
              <div>
                <dt>Configured port</dt>
                <dd>{source.containerPort ?? "Uses the app's current setting"}</dd>
              </div>
              <div>
                <dt>Port source</dt>
                <dd>
                  {source.containerPortSource
                    ? PORT_SOURCE_LABELS[source.containerPortSource] ?? source.containerPortSource
                    : "Not set"}
                  {source.containerPortConfidence && source.containerPortConfidence !== "none"
                    ? ` (${source.containerPortConfidence} confidence)`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>Last internal health result</dt>
                <dd>{source.lastInternalHealthResult ?? "Not yet checked"}</dd>
              </div>
              <div>
                <dt>Last public route result</dt>
                <dd>{source.lastPublicHealthResult ?? "Not yet checked"}</dd>
              </div>
              <div>
                <dt>Last deployment status</dt>
                <dd>{source.lastDeploymentStatus ?? "Never deployed"}</dd>
              </div>
              <div>
                <dt>Auto deploy</dt>
                <dd>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={source.autoDeploy}
                      disabled={savingAutoDeploy || !githubUsable}
                      onChange={(event) => void toggleAutoDeploy(event.target.checked)}
                    />
                    <span>
                      {source.autoDeploy ? "Enabled" : "Disabled"}
                      {savingAutoDeploy ? " (saving…)" : ""}
                    </span>
                  </label>
                  <p className="text-faint">
                    When enabled, new commits on <code>{source.branch}</code> deploy automatically
                    (checked about once a minute).
                  </p>
                </dd>
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
              <div>
                <dt>Latest remote commit</dt>
                <dd title={source.latestRemoteCommitSha ?? undefined}>
                  <code>{shortSha(source.latestRemoteCommitSha)}</code>
                </dd>
              </div>
              <div>
                <dt>Latest deployed commit</dt>
                <dd title={source.latestDeployedCommitSha ?? undefined}>
                  <code>{shortSha(source.latestDeployedCommitSha)}</code>
                  {source.latestDeployedCommitMessage && (
                    <span className="text-faint"> — {source.latestDeployedCommitMessage}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Last deployed</dt>
                <dd>{formatDate(source.latestDeployedAt)}</dd>
              </div>
            </dl>

            {source.validationError && (
              <p className="section-description">
                Validation error: <code>{source.validationError}</code>
              </p>
            )}

            {inspectError && <div className="error-banner">{inspectError}</div>}
            {deployError && <div className="error-banner">{deployError}</div>}

            {inspection && <InspectionResultCard inspection={inspection} />}

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
                onClick={() => void runInspect()}
                disabled={inspecting || !githubUsable}
                title={!githubUsable ? "Connect GitHub before inspecting this repository." : undefined}
              >
                {inspecting ? "Inspecting..." : "Inspect Repository"}
              </button>
              <button
                className="primary-button compact"
                type="button"
                onClick={() => setShowDeployConfirm(true)}
                disabled={!githubUsable || deployInProgress}
                title={
                  !githubUsable
                    ? "Connect GitHub before deploying."
                    : deployInProgress
                      ? "A deployment for this app is already in progress."
                      : undefined
                }
              >
                {deployInProgress ? "Deploying..." : "Deploy from GitHub"}
              </button>
              <button
                className="secondary-button compact"
                type="button"
                onClick={() => setShowLinkDialog(true)}
              >
                Edit Source
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

      {source && (
        <ConfirmationDialog
          open={showDeployConfirm}
          title="Deploy from GitHub?"
          message={
            <p>
              This builds and deploys <strong>{source.repositoryOwner}/{source.repositoryName}</strong>{" "}
              at branch <strong>{source.branch}</strong>
              {source.latestRemoteCommitSha && (
                <>
                  {" "}(latest known commit <code>{shortSha(source.latestRemoteCommitSha)}</code>)
                </>
              )}
              . The current container is preserved and automatically restored if the build or
              health verification fails.
              <label className="checkbox-field" style={{ marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={deployNoCache}
                  onChange={(event) => setDeployNoCache(event.target.checked)}
                />
                <span>
                  Build without cache — slower, but clears a corrupt build cache (use this if a
                  deploy fails with "parent snapshot … does not exist").
                </span>
              </label>
            </p>
          }
          confirmLabel={deployNoCache ? "Deploy without cache" : "Deploy"}
          confirming={deploying}
          onConfirm={() => void confirmDeploy()}
          onCancel={() => {
            setShowDeployConfirm(false);
            setDeployNoCache(false);
          }}
        />
      )}

      {showLinkDialog && (
        <LinkRepositoryDialog
          appId={appId}
          existing={source}
          onClose={() => setShowLinkDialog(false)}
          onSaved={(saved, outcome) => {
            setSource(saved);
            // The saved config's build_strategy/detected_project_type are
            // already reset to null server-side on any config change —
            // clear the locally-held inspection result too, so a stale
            // card can never be shown for a repository/branch/subdirectory
            // that no longer matches what was actually inspected.
            setInspection(null);
            setShowLinkDialog(false);

            if (outcome.inspectionFailed) {
              // The source row is saved either way, but the mandatory
              // authoritative re-inspection that follows a save did not
              // succeed — deployment is never started in this case (see
              // saveAndInspect/saveAndDeploy above).
              setNotice(
                `Source configuration saved, but inspecting it afterward failed: ${outcome.inspectionFailed}. Use "Inspect Repository" below to retry before deploying.`
              );
            } else if (outcome.deployed) {
              setDeployInProgress(true);
              setNotice("Source configuration saved, inspected, and a deployment has started — see progress below.");
            } else if (outcome.deployStartError) {
              setNotice(
                `Source configuration saved and inspected, but the deployment could not be started automatically: ${outcome.deployStartError}. Use "Deploy from GitHub" below to retry.`
              );
            } else {
              setNotice(
                'Source configuration saved and inspected. This application is not yet serving repository code — use "Deploy from GitHub" below when you\'re ready.'
              );
            }
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

function InspectionResultCard({ inspection }: { inspection: RepositoryInspectionResult }) {
  return (
    <div className="wizard-row inspection-card">
      <dl className="wizard-review-grid">
        <div>
          <dt>Detected type</dt>
          <dd>{PROJECT_TYPE_LABELS[inspection.detectedProjectType] ?? inspection.detectedProjectType}</dd>
        </div>
        <div>
          <dt>Recommended strategy</dt>
          <dd>{inspection.recommendedStrategy}</dd>
        </div>
        {inspection.packageJson && (
          <>
            <div>
              <dt>Package manager</dt>
              <dd>{inspection.packageJson.packageManager}</dd>
            </div>
            <div>
              <dt>Start script</dt>
              <dd>{inspection.packageJson.hasStartScript ? "Found" : "Missing"}</dd>
            </div>
            <div>
              <dt>Build script</dt>
              <dd>{inspection.packageJson.hasBuildScript ? "Found" : "None"}</dd>
            </div>
          </>
        )}
      </dl>

      {inspection.presentFiles.length > 0 && (
        <>
          <p className="section-description">Detected files</p>
          <ul className="wizard-file-list">
            {inspection.presentFiles.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {!inspection.supported && inspection.unsupportedReason && (
        <div className="warning-banner">{inspection.unsupportedReason}</div>
      )}

      {inspection.warnings.length > 0 && (
        <ul className="wizard-warning-list">
          {inspection.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SaveOutcome {
  deployed: boolean;
  deployStartError?: string;
  /** Set when the save itself succeeded but the mandatory, authoritative
   * server-side re-inspection that follows it did not. */
  inspectionFailed?: string;
}

interface LinkRepositoryDialogProps {
  appId: number;
  existing: AppSourceInfo | null;
  onClose: () => void;
  onSaved: (source: AppSourceInfo, outcome: SaveOutcome) => void;
}

type WizardStep = "provider" | "repository" | "branch" | "inspect" | "deployment" | "review";

const STEP_ORDER: WizardStep[] = ["provider", "repository", "branch", "inspect", "deployment", "review"];
const STEP_LABELS: Record<WizardStep, string> = {
  provider: "Provider",
  repository: "Repository",
  branch: "Branch",
  inspect: "Inspect",
  deployment: "Deployment",
  review: "Review"
};

export const PORT_SOURCE_LABELS: Record<string, string> = {
  manual: "Manually entered",
  "dockerfile-expose": "Dockerfile EXPOSE",
  "dockerfile-env": "Dockerfile ENV/ARG or command line",
  "package-script": "package.json script",
  "source-code": "Application source code",
  "framework-default": "Framework default",
  "platform-default": "Platform default",
  none: "Not detected"
};

export const STRATEGY_INFO: Record<Exclude<BuildStrategy, "unsupported">, { title: string; description: string }> = {
  dockerfile: {
    title: "Dockerfile",
    description: "Build using the Dockerfile committed in this repository."
  },
  nodejs: {
    title: "Node.js",
    description: "Use the platform-managed Node.js build strategy."
  },
  static: {
    title: "Static site",
    description: "Build or serve static files using the platform-controlled Nginx strategy."
  }
};

// Reconstructs just enough of a SourceRepository to resume editing an
// already-linked source without a network round-trip — the operator is
// editing a source that's already known to exist and be linked, not
// browsing repositories fresh, so the fields the repositories-listing
// API alone would provide (id/description/pushedAt/updatedAt) are
// filled with safe placeholders never displayed as if they were fetched.
function repositoryFromExistingSource(existing: AppSourceInfo): SourceRepository {
  return {
    id: existing.repositoryId ?? existing.repositoryFullName ?? `${existing.repositoryOwner}/${existing.repositoryName}`,
    owner: existing.repositoryOwner,
    name: existing.repositoryName,
    fullName: existing.repositoryFullName ?? `${existing.repositoryOwner}/${existing.repositoryName}`,
    private: existing.repositoryVisibility === "private",
    archived: false,
    description: null,
    defaultBranch: existing.branch,
    htmlUrl: `https://github.com/${existing.repositoryOwner}/${existing.repositoryName}`,
    pushedAt: null,
    updatedAt: null
  };
}

function LinkRepositoryDialog({ appId, existing, onClose, onSaved }: LinkRepositoryDialogProps) {
  // Editing an already-linked source (Edit Source) resumes at the
  // Branch step, with the repository already populated from the saved
  // configuration — the operator only has to repeat provider/repository
  // selection if they deliberately click "Change Repository" below.
  const [step, setStep] = useState<WizardStep>(existing ? "branch" : "provider");

  const [repos, setRepos] = useState<SourceRepository[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState("");
  const [search, setSearch] = useState("");

  const [selectedRepo, setSelectedRepo] = useState<SourceRepository | null>(
    existing ? repositoryFromExistingSource(existing) : null
  );

  const [branches, setBranches] = useState<SourceBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState("");
  const [selectedBranch, setSelectedBranch] = useState(existing?.branch ?? "");

  const [subdirectory, setSubdirectory] = useState(existing?.subdirectory ?? ".");

  // Populated only by a successful "Inspect Repository" call — never
  // invented client-side. Cleared automatically whenever repository,
  // branch, or subdirectory changes (see the effect below), so a stale
  // inspection from a different selection can never be reused.
  const [inspection, setInspection] = useState<RepositoryInspectionResult | null>(null);
  const [inspectedCommitSha, setInspectedCommitSha] = useState<string | null>(null);
  const [latestCommitMessage, setLatestCommitMessage] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState("");

  // The operator's own explicit strategy choice — inspection's
  // recommendation is advisory only. Starts from whatever was already
  // saved (requirement: "Edit Source must preserve an existing
  // manually-selected strategy on reopen"). strategyManuallySet tracks
  // whether the operator has ever actively chosen a strategy (either by
  // clicking a card, or by having a persisted choice from a previous
  // save) — once true, an inspection rerun must never silently replace
  // it; only false (the default, "just follow the recommendation" mode)
  // lets a fresh inspection update the selection automatically.
  const [selectedStrategy, setSelectedStrategyState] = useState<Exclude<BuildStrategy, "unsupported"> | null>(
    existing?.selectedStrategy ?? null
  );
  const [strategyManuallySet, setStrategyManuallySet] = useState(existing?.selectedStrategy != null);

  const chooseStrategy = (strategy: Exclude<BuildStrategy, "unsupported">) => {
    setSelectedStrategyState(strategy);
    setStrategyManuallySet(true);
  };

  const [dockerfilePath, setDockerfilePath] = useState(existing?.dockerfilePath ?? "Dockerfile");
  const [buildContext, setBuildContext] = useState(existing?.buildContext ?? ".");
  const [containerPort, setContainerPort] = useState(
    existing?.containerPort != null ? String(existing.containerPort) : ""
  );
  // "manual" once the operator types their own value; otherwise the
  // PortDetectionSource of whatever suggestion was accepted from
  // inspection — never invented, always either preloaded from the saved
  // source or set the moment a detection result is actually applied.
  const [containerPortSource, setContainerPortSource] = useState<string | null>(
    existing?.containerPortSource ?? null
  );
  const [containerPortConfidence, setContainerPortConfidence] = useState<string | null>(
    existing?.containerPortConfidence ?? null
  );
  // A re-link/re-validate preserves the operator's existing auto-deploy
  // choice; a brand-new link (no existing source) defaults to ON, matching
  // the server-side default and the create-app wizard.
  const existingAutoDeploy = existing?.autoDeploy ?? true;

  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<"save" | "deploy" | null>(null);
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

  // Load the branch list once, on mount, when resuming Edit Source with
  // an already-populated repository — loadBranches preserves the
  // existing selected branch as long as it's still in the fetched list
  // (see loadBranches above), so this never resets the operator's
  // current branch to the repo's default.
  useEffect(() => {
    if (existing && selectedRepo) {
      void loadBranches(selectedRepo);
    }
    // Only ever meant to run once, on mount, for the edit-existing case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeRepository = () => {
    setSelectedRepo(null);
    setBranches([]);
    setStep("repository");
  };

  // Stale-inspection handling: any change to repository, branch, or
  // subdirectory invalidates a prior inspection result outright — an
  // inspection from one selection must never be reused for another. A
  // manual strategy choice tied to that same now-stale combination is
  // reset back to "follow the recommendation" too — it applied to a
  // different repository/branch/subdirectory than the one now selected.
  // Skipped on the very first run (mount) — an Edit Source reopen must
  // preserve the persisted selectedStrategy it was just initialized
  // from, not immediately wipe it before the operator does anything.
  const skipFirstStaleReset = useRef(true);
  useEffect(() => {
    if (skipFirstStaleReset.current) {
      skipFirstStaleReset.current = false;
      return;
    }
    setInspection(null);
    setInspectedCommitSha(null);
    setLatestCommitMessage(null);
    setInspectError("");
    setSelectedStrategyState(null);
    setStrategyManuallySet(false);
  }, [selectedRepo?.fullName, selectedBranch, subdirectory]);

  const runInspect = async () => {
    if (!selectedRepo || !selectedBranch) {
      return;
    }

    try {
      setInspecting(true);
      setInspectError("");

      const [inspectResponse, commitsResponse] = await Promise.all([
        fetch(
          `/api/integrations/github/repositories/${selectedRepo.owner}/${selectedRepo.name}/inspect`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ branch: selectedBranch, subdirectory })
          }
        ),
        fetch(
          `/api/integrations/github/repositories/${selectedRepo.owner}/${selectedRepo.name}/commits?` +
            new URLSearchParams({ branch: selectedBranch, page: "1", perPage: "1" }).toString()
        )
      ]);

      const inspectResult = (await inspectResponse.json().catch(() => ({}))) as Partial<InspectSourceResponse>;

      if (!inspectResponse.ok || !inspectResult.success) {
        throw new Error(inspectResult.message || "Unable to inspect repository");
      }

      setInspection(inspectResult.inspection ?? null);
      setInspectedCommitSha(inspectResult.commitSha ?? null);

      // Inspection recommendations are advisory: only auto-apply the
      // recommendation while the operator hasn't made an explicit
      // choice of their own — an inspection rerun must never silently
      // replace a manual strategy selection.
      if (!strategyManuallySet) {
        const recommended = inspectResult.inspection?.recommendedStrategy;
        if (recommended && recommended !== "unsupported") {
          setSelectedStrategyState(recommended);
        }
      }

      // Prefill the container port only from a high-confidence, single,
      // unambiguous detection, and only if the operator hasn't already
      // typed a value — an ambiguous/conflicting/low-confidence result
      // is shown (see the Deployment step below) but never auto-applied.
      const portDetection = inspectResult.inspection?.portDetection;
      if (portDetection && portDetection.detectedPort !== null && portDetection.confidence === "high" && !containerPort.trim()) {
        setContainerPort(String(portDetection.detectedPort));
        setContainerPortSource(portDetection.source);
        setContainerPortConfidence(portDetection.confidence);
      }

      // The commit message lookup is best-effort context only — the
      // inspection result itself does not depend on it succeeding.
      if (commitsResponse.ok) {
        const commitsResult = (await commitsResponse.json().catch(() => null)) as GithubCommitsResponse | null;
        setLatestCommitMessage(commitsResult?.commits?.[0]?.message ?? null);
      } else {
        setLatestCommitMessage(null);
      }
    } catch (error) {
      setInspectError(error instanceof Error ? error.message : "Unable to inspect repository");
      setInspection(null);
      setInspectedCommitSha(null);
      setLatestCommitMessage(null);
    } finally {
      setInspecting(false);
    }
  };

  const recommendedStrategy = inspection?.recommendedStrategy ?? null;
  const isUnsupported = inspection !== null && !inspection.supported;

  const goBack = () => {
    const index = STEP_ORDER.indexOf(step);
    if (index <= 0) {
      return;
    }
    // Unsupported repositories skip the Deployment step entirely (there is
    // nothing to configure), so going back from Review must return to
    // Inspect rather than to the skipped Deployment step.
    if (step === "review" && isUnsupported) {
      setStep("inspect");
      return;
    }
    setStep(STEP_ORDER[index - 1]);
  };

  const goNext = () => {
    if (step === "inspect" && isUnsupported) {
      setStep("review");
      return;
    }
    const index = STEP_ORDER.indexOf(step);
    if (index < STEP_ORDER.length - 1) {
      setStep(STEP_ORDER[index + 1]);
    }
  };

  const nodejsStartScriptMissing =
    selectedStrategy === "nodejs" && inspection?.packageJson?.hasStartScript === false;

  const canContinue =
    step === "provider" ||
    (step === "repository" && selectedRepo !== null) ||
    (step === "branch" && selectedBranch.length > 0) ||
    (step === "inspect" && inspection !== null) ||
    (step === "deployment" &&
      selectedStrategy !== null &&
      !nodejsStartScriptMissing &&
      (selectedStrategy !== "dockerfile" || (dockerfilePath.length > 0 && buildContext.length > 0)));

  const buildSourcePayload = () => {
    if (!selectedRepo || !selectedStrategy) {
      return null;
    }

    // deploymentMode is what the backend uses for source-save validation
    // (it decides whether Dockerfile existence is checked) — driven by
    // the OPERATOR'S selected strategy, not the inspection
    // recommendation. selectedStrategy itself is what the actual deploy
    // now builds with (see github-deploy-service.ts): Node.js and static
    // still auto-detect their own build details (package manager, start
    // script, etc.) fresh at deploy time, but WHICH of the three
    // strategies gets used follows the operator's explicit choice, never
    // silently the inspection's own opinion.
    const deploymentMode: DeploymentMode = selectedStrategy === "dockerfile" ? "dockerfile" : "prebuilt-image";

    return {
      repositoryOwner: selectedRepo.owner,
      repositoryName: selectedRepo.name,
      branch: selectedBranch,
      subdirectory,
      deploymentMode,
      dockerfilePath,
      buildContext,
      selectedStrategy,
      containerPort: containerPort.trim() ? Number(containerPort) : undefined,
      // Only ever sent once a port value is actually present — an empty
      // port has no source/confidence to report either.
      containerPortSource: containerPort.trim() ? containerPortSource ?? "manual" : undefined,
      containerPortConfidence: containerPort.trim() ? containerPortConfidence ?? undefined : undefined,
      autoDeploy: existingAutoDeploy
    };
  };

  const saveSource = async (): Promise<AppSourceInfo> => {
    const payload = buildSourcePayload();
    if (!payload) {
      throw new Error("Select a repository and branch before saving.");
    }

    const response = await fetch(`/api/apps/${appId}/source`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = (await response.json().catch(() => ({}))) as Partial<AppSourceResponse>;

    if (!response.ok || !result.success || !result.source) {
      throw new Error(result.message || "Unable to save source configuration");
    }

    return result.source;
  };

  interface SaveAndInspectResult {
    source: AppSourceInfo;
    inspectionOk: boolean;
    inspectionError?: string;
  }

  // The wizard's own pre-save inspection (the "Inspect" step above) is
  // only a preview — browser-supplied inspection data is never trusted
  // as the persisted, authoritative result. After every save, this calls
  // the existing per-app inspection endpoint, which re-inspects the
  // repository from the server and persists detected_project_type/
  // build_strategy/latest_remote_commit_sha itself. Saving the
  // configuration always resets those fields to null server-side (see
  // app-source-database.ts's upsertAppSource), so re-fetching the source
  // after this succeeds is what makes "Detected type" show the real
  // value instead of "Not inspected yet".
  const saveAndInspect = async (): Promise<SaveAndInspectResult> => {
    const saved = await saveSource();

    const inspectResponse = await fetch(`/api/apps/${appId}/source/inspect`, { method: "POST" });
    const inspectResult = (await inspectResponse.json().catch(() => ({}))) as Partial<InspectSourceResponse>;

    if (!inspectResponse.ok || !inspectResult.success) {
      return {
        source: saved,
        inspectionOk: false,
        inspectionError: inspectResult.message || "Unable to inspect the repository after saving"
      };
    }

    const refreshedResponse = await fetch(`/api/apps/${appId}/source`);
    const refreshedResult = (await refreshedResponse.json().catch(() => ({}))) as Partial<AppSourceResponse>;
    const refreshedSource = refreshedResponse.ok && refreshedResult.source ? refreshedResult.source : saved;

    return { source: refreshedSource, inspectionOk: true };
  };

  const saveWithoutDeploying = async () => {
    if (saving) {
      return;
    }
    try {
      setSaving(true);
      setPendingAction("save");
      setSaveError("");
      const { source, inspectionOk, inspectionError } = await saveAndInspect();
      onSaved(source, { deployed: false, inspectionFailed: inspectionOk ? undefined : inspectionError });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save source configuration");
    } finally {
      setSaving(false);
      setPendingAction(null);
    }
  };

  const saveAndDeploy = async () => {
    if (saving) {
      return;
    }
    try {
      setSaving(true);
      setPendingAction("deploy");
      setSaveError("");

      // The source must be saved AND authoritatively re-inspected — both
      // successfully — before any deployment is ever started.
      const { source, inspectionOk, inspectionError } = await saveAndInspect();

      if (!inspectionOk) {
        onSaved(source, { deployed: false, inspectionFailed: inspectionError });
        return;
      }

      const deployResponse = await fetch(`/api/apps/${appId}/deploy/github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const deployResult = (await deployResponse.json().catch(() => ({}))) as Partial<GithubDeployResponse>;

      if (!deployResponse.ok || !deployResult.success) {
        onSaved(source, { deployed: false, deployStartError: deployResult.message || "Unable to start deployment" });
        return;
      }

      onSaved(source, { deployed: true });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save source configuration");
    } finally {
      setSaving(false);
      setPendingAction(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <section className="form-modal wizard-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">{existing ? "Edit Source" : "Link Repository"}</p>
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
                Repository: <strong>{selectedRepo.fullName}</strong>{" "}
                <button className="secondary-button compact" type="button" onClick={changeRepository}>
                  Change Repository
                </button>
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

          {step === "inspect" && selectedRepo && (
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
              </dl>

              <label>
                <span>Subdirectory (optional)</span>
                <input
                  value={subdirectory}
                  onChange={(event) => setSubdirectory(event.target.value)}
                  placeholder="."
                />
                <small>
                  Use this when the app lives in a subfolder of the repository. Leave as "." to use
                  the repository root. Changing this clears any previous inspection result.
                </small>
              </label>

              <div className="form-actions form-actions-start">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={inspecting || !selectedBranch}
                  onClick={() => void runInspect()}
                >
                  {inspecting ? "Inspecting..." : inspection ? "Re-inspect Repository" : "Inspect Repository"}
                </button>
              </div>

              {inspectError && <div className="error-banner">{inspectError}</div>}

              {inspection && (
                <>
                  <dl className="wizard-review-grid">
                    <div>
                      <dt>Latest remote commit</dt>
                      <dd title={inspectedCommitSha ?? undefined}>
                        <code>{shortSha(inspectedCommitSha)}</code>
                        {latestCommitMessage && <span className="text-faint"> — {latestCommitMessage}</span>}
                      </dd>
                    </div>
                  </dl>
                  <InspectionResultCard inspection={inspection} />

                  <div className="wizard-row inspection-card">
                    <dl className="wizard-review-grid">
                      <div>
                        <dt>Suggested container port</dt>
                        <dd>{inspection.portDetection.detectedPort ?? "None detected"}</dd>
                      </div>
                      <div>
                        <dt>Detected from</dt>
                        <dd>{PORT_SOURCE_LABELS[inspection.portDetection.source] ?? inspection.portDetection.source}</dd>
                      </div>
                      <div>
                        <dt>Confidence</dt>
                        <dd style={{ textTransform: "capitalize" }}>{inspection.portDetection.confidence}</dd>
                      </div>
                    </dl>
                    {inspection.portDetection.evidence.length > 0 && (
                      <ul className="wizard-file-list">
                        {inspection.portDetection.evidence.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    )}
                    {inspection.portDetection.warnings.length > 0 && (
                      <ul className="wizard-warning-list">
                        {inspection.portDetection.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}

              {!inspection && !inspecting && !inspectError && (
                <p className="section-description">
                  Inspect this repository before continuing — the platform needs to know what kind
                  of project it is before it can offer a build strategy.
                </p>
              )}
            </>
          )}

          {step === "deployment" && inspection && !isUnsupported && (
            <>
              <p className="section-description">
                Inspection's recommendation is a starting point, not a requirement — choose any
                supported deployment strategy below.
              </p>
              <div className="wizard-row-list">
                {(Object.keys(STRATEGY_INFO) as Array<Exclude<BuildStrategy, "unsupported">>).map((key) => {
                  const isSelected = selectedStrategy === key;
                  const isRecommended = recommendedStrategy === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`wizard-row strategy-card ${isSelected ? "selected" : ""}`}
                      onClick={() => chooseStrategy(key)}
                      aria-pressed={isSelected}
                    >
                      <strong>
                        {STRATEGY_INFO[key].title}
                        {isRecommended && (
                          <span className="status-badge positive compact">
                            {isSelected ? "Recommended" : "Detected"}
                          </span>
                        )}
                      </strong>
                      <span className="text-faint">{STRATEGY_INFO[key].description}</span>
                      {!isRecommended && <span className="text-faint">Not detected for this repository.</span>}
                    </button>
                  );
                })}
              </div>

              {selectedStrategy === "dockerfile" && (
                <>
                  <label>
                    <span>Dockerfile path</span>
                    <input
                      value={dockerfilePath}
                      onChange={(event) => setDockerfilePath(event.target.value)}
                      placeholder="Dockerfile"
                    />
                    <small>Relative to the subdirectory above — e.g. tools/roadmap-studio/Dockerfile with subdirectory "." means the path is exactly that.</small>
                  </label>
                  <label>
                    <span>Build context</span>
                    <input
                      value={buildContext}
                      onChange={(event) => setBuildContext(event.target.value)}
                      placeholder="."
                    />
                    <small>"." means the subdirectory itself (repository root when subdirectory is ".").</small>
                  </label>
                </>
              )}

              {selectedStrategy === "nodejs" &&
                (inspection.packageJson ? (
                  <dl className="wizard-review-grid">
                    <div>
                      <dt>Package manager</dt>
                      <dd>{inspection.packageJson.packageManager}</dd>
                    </div>
                    <div>
                      <dt>Start script</dt>
                      <dd>{inspection.packageJson.hasStartScript ? "Found" : "Missing"}</dd>
                    </div>
                    <div>
                      <dt>Build script</dt>
                      <dd>{inspection.packageJson.hasBuildScript ? "Found" : "None"}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="section-description">
                    No package.json was found during inspection — re-inspect after confirming this
                    repository is a Node.js project.
                  </p>
                ))}

              {nodejsStartScriptMissing && (
                <div className="warning-banner">
                  No "start" script was found in package.json. Add one to the repository before this
                  application can be deployed as a Node.js build.
                </div>
              )}

              {selectedStrategy === "static" && (
                <p className="section-description">
                  Static output directory is not currently configurable — the entire contents of{" "}
                  <code>{subdirectory}</code> are served as-is by the platform-managed Nginx image.
                </p>
              )}

              <label>
                <span>Container port (optional)</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={containerPort}
                  onChange={(event) => {
                    setContainerPort(event.target.value);
                    setContainerPortSource("manual");
                    setContainerPortConfidence(null);
                  }}
                  placeholder="Uses the app's current port if left blank"
                />
                <small>Only needed when the built image should expose a different port than the app's current setting.</small>
              </label>

              {containerPort.trim() && (
                <p className="section-description">
                  {containerPortSource === "manual" || !containerPortSource
                    ? "Manually entered."
                    : `Detected from ${PORT_SOURCE_LABELS[containerPortSource] ?? containerPortSource}${
                        containerPortConfidence ? ` (${containerPortConfidence} confidence)` : ""
                      }.`}
                  {containerPortConfidence === "low" && " Suggested port, not confirmed — verify before deploying."}
                </p>
              )}

              {inspection.portDetection.detectedPort === null && inspection.portDetection.warnings.length > 0 && (
                <div className="warning-banner">{inspection.portDetection.warnings.join(" ")}</div>
              )}
            </>
          )}

          {step === "review" && selectedRepo && (
            <>
              {isUnsupported && inspection?.unsupportedReason && (
                <div className="warning-banner">{inspection.unsupportedReason}</div>
              )}

              <dl className="wizard-review-grid">
                <div>
                  <dt>Repository</dt>
                  <dd>{selectedRepo.fullName}</dd>
                </div>
                <div>
                  <dt>Visibility</dt>
                  <dd>{selectedRepo.private ? "Private" : "Public"}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{selectedBranch}</dd>
                </div>
                <div>
                  <dt>Subdirectory</dt>
                  <dd>
                    <code>{subdirectory}</code>
                  </dd>
                </div>
                <div>
                  <dt>Latest remote commit</dt>
                  <dd title={inspectedCommitSha ?? undefined}>
                    <code>{shortSha(inspectedCommitSha)}</code>
                    {latestCommitMessage && <span className="text-faint"> — {latestCommitMessage}</span>}
                  </dd>
                </div>
                <div>
                  <dt>Detected type</dt>
                  <dd>
                    {inspection
                      ? PROJECT_TYPE_LABELS[inspection.detectedProjectType] ?? inspection.detectedProjectType
                      : "Not inspected"}
                  </dd>
                </div>
                {!isUnsupported && selectedStrategy && (
                  <div>
                    <dt>Build strategy</dt>
                    <dd>
                      {STRATEGY_INFO[selectedStrategy].title}
                      {recommendedStrategy && recommendedStrategy !== selectedStrategy && (
                        <span className="text-faint"> (recommended: {STRATEGY_INFO[recommendedStrategy as Exclude<BuildStrategy, "unsupported">]?.title ?? recommendedStrategy})</span>
                      )}
                    </dd>
                  </div>
                )}
                {selectedStrategy === "nodejs" && inspection?.packageJson && (
                  <div>
                    <dt>Package manager</dt>
                    <dd>{inspection.packageJson.packageManager}</dd>
                  </div>
                )}
                {selectedStrategy === "dockerfile" && (
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
                  <dt>Container port</dt>
                  <dd>{containerPort.trim() ? containerPort : "Uses the app's current port"}</dd>
                </div>
              </dl>

              {inspection && inspection.warnings.length > 0 && (
                <ul className="wizard-warning-list">
                  {inspection.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}

              <p className="section-description">
                {isUnsupported
                  ? "This project type is not supported for automatic deployment yet. You can still save the repository link for reference, but deployment is disabled until a Dockerfile is added."
                  : "Saving validates this configuration against GitHub immediately (repository access and branch existence). Choose below whether to just save it, or save it and start a deployment right away."}
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
              <>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={saving}
                  onClick={() => void saveWithoutDeploying()}
                >
                  {pendingAction === "save" ? "Saving..." : existing ? "Save changes" : "Save without deploying"}
                </button>
                {!isUnsupported && (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={saving}
                    onClick={() => void saveAndDeploy()}
                  >
                    {pendingAction === "deploy"
                      ? "Saving and deploying..."
                      : existing
                        ? "Save changes and deploy"
                        : "Save and deploy"}
                  </button>
                )}
              </>
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
