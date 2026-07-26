import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiError,
  AppSourceInfo,
  AppSourceResponse,
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

  const [inspection, setInspection] = useState<RepositoryInspectionResult | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState("");

  const [deployInProgress, setDeployInProgress] = useState(false);
  const [showDeployConfirm, setShowDeployConfirm] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState("");

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
        body: JSON.stringify({})
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
                disabled={inspecting || !connection?.connected}
                title={!connection?.connected ? "Connect GitHub before inspecting this repository." : undefined}
              >
                {inspecting ? "Inspecting..." : "Inspect Repository"}
              </button>
              <button
                className="primary-button compact"
                type="button"
                onClick={() => setShowDeployConfirm(true)}
                disabled={!connection?.connected || deployInProgress}
                title={
                  !connection?.connected
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
            </p>
          }
          confirmLabel="Deploy"
          confirming={deploying}
          onConfirm={() => void confirmDeploy()}
          onCancel={() => setShowDeployConfirm(false)}
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

const STRATEGY_INFO: Record<Exclude<BuildStrategy, "unsupported">, { title: string; description: string }> = {
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

  const [dockerfilePath, setDockerfilePath] = useState(existing?.dockerfilePath ?? "Dockerfile");
  const [buildContext, setBuildContext] = useState(existing?.buildContext ?? ".");
  const [containerPort, setContainerPort] = useState(
    existing?.containerPort != null ? String(existing.containerPort) : ""
  );
  // autoDeploy has no UI control (it is currently inert on the backend —
  // no scheduler or webhook ever reads it) but the existing stored value
  // is preserved across a save for backward compatibility rather than
  // being silently reset to false.
  const existingAutoDeploy = existing?.autoDeploy ?? false;

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

  // Stale-inspection handling: any change to repository, branch, or
  // subdirectory invalidates a prior inspection result outright — an
  // inspection from one selection must never be reused for another.
  useEffect(() => {
    setInspection(null);
    setInspectedCommitSha(null);
    setLatestCommitMessage(null);
    setInspectError("");
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
    recommendedStrategy === "nodejs" && inspection?.packageJson?.hasStartScript === false;

  const canContinue =
    step === "provider" ||
    (step === "repository" && selectedRepo !== null) ||
    (step === "branch" && selectedBranch.length > 0) ||
    (step === "inspect" && inspection !== null) ||
    (step === "deployment" &&
      recommendedStrategy !== null &&
      recommendedStrategy !== "unsupported" &&
      !nodejsStartScriptMissing &&
      (recommendedStrategy !== "dockerfile" || (dockerfilePath.length > 0 && buildContext.length > 0)));

  const buildSourcePayload = () => {
    if (!selectedRepo || !recommendedStrategy) {
      return null;
    }

    // deploymentMode is the one field the backend actually persists and
    // acts on for source-save validation (it decides whether Dockerfile
    // existence is checked). The Node.js and static build strategies are
    // always auto-detected fresh at deploy time from the real repository
    // content (see repository-inspection-service.ts / github-deploy-
    // service.ts) — there is no backend field to "select" them, so they
    // both map to "prebuilt-image" here, which simply skips the
    // Dockerfile-existence check that only makes sense for the Dockerfile
    // strategy.
    const deploymentMode: DeploymentMode = recommendedStrategy === "dockerfile" ? "dockerfile" : "prebuilt-image";

    return {
      repositoryOwner: selectedRepo.owner,
      repositoryName: selectedRepo.name,
      branch: selectedBranch,
      subdirectory,
      deploymentMode,
      dockerfilePath,
      buildContext,
      containerPort: containerPort.trim() ? Number(containerPort) : undefined,
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

          {step === "deployment" && inspection && recommendedStrategy && recommendedStrategy !== "unsupported" && (
            <>
              <div className="wizard-row-list">
                {(Object.keys(STRATEGY_INFO) as Array<Exclude<BuildStrategy, "unsupported">>).map((key) => {
                  const active = recommendedStrategy === key;
                  return (
                    <div
                      key={key}
                      className={`wizard-row strategy-card ${active ? "selected" : "disabled"}`}
                    >
                      <strong>
                        {STRATEGY_INFO[key].title}
                        {active && <span className="status-badge positive compact">Detected</span>}
                      </strong>
                      <span className="text-faint">{STRATEGY_INFO[key].description}</span>
                      {!active && <span className="text-faint">Not detected for this repository.</span>}
                    </div>
                  );
                })}
              </div>

              {recommendedStrategy === "dockerfile" && (
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

              {recommendedStrategy === "nodejs" && inspection.packageJson && (
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
              )}

              {nodejsStartScriptMissing && (
                <div className="warning-banner">
                  No "start" script was found in package.json. Add one to the repository before this
                  application can be deployed as a Node.js build.
                </div>
              )}

              {recommendedStrategy === "static" && (
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
                  onChange={(event) => setContainerPort(event.target.value)}
                  placeholder="Uses the app's current port if left blank"
                />
                <small>Only needed when the built image should expose a different port than the app's current setting.</small>
              </label>
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
                {!isUnsupported && recommendedStrategy && (
                  <div>
                    <dt>Build strategy</dt>
                    <dd>{STRATEGY_INFO[recommendedStrategy as Exclude<BuildStrategy, "unsupported">]?.title ?? recommendedStrategy}</dd>
                  </div>
                )}
                {recommendedStrategy === "nodejs" && inspection?.packageJson && (
                  <div>
                    <dt>Package manager</dt>
                    <dd>{inspection.packageJson.packageManager}</dd>
                  </div>
                )}
                {recommendedStrategy === "dockerfile" && (
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
                  {pendingAction === "save" ? "Saving..." : "Save without deploying"}
                </button>
                {!isUnsupported && (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={saving}
                    onClick={() => void saveAndDeploy()}
                  >
                    {pendingAction === "deploy" ? "Saving and deploying..." : "Save and deploy"}
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
