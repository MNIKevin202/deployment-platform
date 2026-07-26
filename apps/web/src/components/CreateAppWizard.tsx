import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  BuildBriefRequestPayload,
  BuildBriefResponse,
  BuildBriefRuntime,
  CreateAppWizardPayload,
  CreateAppWizardResponse,
  CreatedAppSummary,
  GithubBranchesResponse,
  GithubConnectionInfo,
  GithubRepositoriesResponse,
  MaskedGlobalEnvVar,
  RestartPolicy,
  SourceBranch,
  SourceRepository,
  WizardEnvVarInput,
  WizardVolumeInput
} from "../types/api";
import {
  isValidAppName,
  isValidContainerPath,
  isValidImage,
  isValidPort,
  isValidVolumeName,
  validateEnvVars,
  validateStorageMounts
} from "../lib/wizardValidation";

interface CreateAppWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (app: CreatedAppSummary) => void;
}

const STEP_LABELS = [
  "Source",
  "Basics",
  "Runtime",
  "Environment",
  "Storage",
  "Domain & Networking",
  "Review & Create"
] as const;

const LAST_STEP = STEP_LABELS.length - 1;

// Placeholder used only when the "Deploy from GitHub" path is chosen —
// app creation still requires a pullable image to exist right away; the
// real image is built and swapped in by the first GitHub deployment,
// triggered either immediately (if the operator chooses "Create and
// deploy") or later from the app's Source tab.
const GITHUB_PLACEHOLDER_IMAGE = "nginx:alpine";

const RUNTIME_OPTIONS: Array<{ value: BuildBriefRuntime; label: string }> = [
  { value: "nodejs", label: "Node.js" },
  { value: "python", label: "Python" },
  { value: "php", label: "PHP" },
  { value: "static", label: "Static site" },
  { value: "docker", label: "Generic / pre-built Docker image" },
  { value: "other", label: "Other" }
];

const RESTART_POLICY_OPTIONS: Array<{ value: RestartPolicy; label: string }> = [
  { value: "unless-stopped", label: "Unless stopped (recommended)" },
  { value: "always", label: "Always" },
  { value: "on-failure", label: "On failure" },
  { value: "no", label: "Never" }
];

interface EnvRow extends WizardEnvVarInput {
  rowId: number;
}

interface VolumeRow extends WizardVolumeInput {
  rowId: number;
}

let nextRowId = 1;

function makeEnvRow(): EnvRow {
  return { rowId: nextRowId++, key: "", value: "", isSecret: false, enabled: true };
}

function makeVolumeRow(): VolumeRow {
  return { rowId: nextRowId++, containerPath: "", volumeName: "", readOnly: false };
}

async function readApiError(
  response: Response,
  fallbackMessage: string
): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

type SourceType = "manual" | "github";

export default function CreateAppWizard({
  open,
  onClose,
  onCreated
}: CreateAppWizardProps) {
  const [step, setStep] = useState(0);

  const [sourceType, setSourceType] = useState<SourceType>("manual");

  const [githubConnection, setGithubConnection] = useState<GithubConnectionInfo | null>(null);
  const [githubRepos, setGithubRepos] = useState<SourceRepository[]>([]);
  const [githubReposLoading, setGithubReposLoading] = useState(false);
  const [githubReposError, setGithubReposError] = useState("");
  const [githubRepo, setGithubRepo] = useState<SourceRepository | null>(null);
  const [githubBranches, setGithubBranches] = useState<SourceBranch[]>([]);
  const [githubBranch, setGithubBranch] = useState("");
  const [githubSubdirectory, setGithubSubdirectory] = useState(".");
  const [deployAfterCreate, setDeployAfterCreate] = useState(true);

  const [name, setName] = useState("");
  const [image, setImage] = useState("");

  const [containerPort, setContainerPort] = useState("3000");
  const [restartPolicy, setRestartPolicy] = useState<RestartPolicy>("unless-stopped");
  const [runtime, setRuntime] = useState<BuildBriefRuntime>("docker");
  const [description, setDescription] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [healthCheckPath, setHealthCheckPath] = useState("");

  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [volumeRows, setVolumeRows] = useState<VolumeRow[]>([]);

  const [globalVars, setGlobalVars] = useState<MaskedGlobalEnvVar[]>([]);
  const [globalVarsLoaded, setGlobalVarsLoaded] = useState(false);

  const [domain, setDomain] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState("");
  const [briefCopied, setBriefCopied] = useState(false);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdApp, setCreatedApp] = useState<CreatedAppSummary | null>(null);
  const [postCreateNotice, setPostCreateNotice] = useState("");

  const resetWizard = useCallback(() => {
    setStep(0);
    setSourceType("manual");
    setGithubRepo(null);
    setGithubBranch("");
    setGithubSubdirectory(".");
    setDeployAfterCreate(true);
    setName("");
    setImage("");
    setContainerPort("3000");
    setRestartPolicy("unless-stopped");
    setRuntime("docker");
    setDescription("");
    setStartCommand("");
    setHealthCheckPath("");
    setEnvRows([]);
    setVolumeRows([]);
    setDomain(null);
    setBrief("");
    setBriefError("");
    setBriefCopied(false);
    setCreateError("");
    setCreatedApp(null);
    setPostCreateNotice("");
  }, []);

  useEffect(() => {
    if (open) {
      resetWizard();
    }
  }, [open, resetWizard]);

  useEffect(() => {
    if (!open || globalVarsLoaded) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch("/api/environment/global");

        if (!response.ok || cancelled) {
          return;
        }

        const result = (await response.json()) as { variables: MaskedGlobalEnvVar[] };

        if (!cancelled) {
          setGlobalVars(result.variables);
          setGlobalVarsLoaded(true);
        }
      } catch {
        // Non-critical for the wizard — global variables are shown for
        // context only, so a failed fetch just leaves the list empty.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, globalVarsLoaded]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch("/api/integrations/github");
        if (!response.ok || cancelled) return;
        const result = (await response.json()) as GithubConnectionInfo;
        if (!cancelled) setGithubConnection(result);
      } catch {
        // Non-critical here — the Source step shows its own "not
        // connected" state if this never resolves.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  const loadGithubRepos = useCallback(async () => {
    try {
      setGithubReposLoading(true);
      setGithubReposError("");

      const response = await fetch("/api/integrations/github/repositories?page=1&perPage=20");

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load repositories"));
      }

      const result = (await response.json()) as GithubRepositoriesResponse;
      setGithubRepos(result.repositories);
    } catch (error) {
      setGithubReposError(error instanceof Error ? error.message : "Unable to load repositories");
    } finally {
      setGithubReposLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && step === 0 && sourceType === "github" && githubConnection?.connected) {
      void loadGithubRepos();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, sourceType, githubConnection?.connected]);

  const selectGithubRepo = async (repo: SourceRepository) => {
    setGithubRepo(repo);
    setGithubBranch(repo.defaultBranch);
    setName((current) => current || repo.name);
    setImage((current) => current || GITHUB_PLACEHOLDER_IMAGE);

    try {
      const response = await fetch(
        `/api/integrations/github/repositories/${repo.owner}/${repo.name}/branches`
      );
      if (!response.ok) return;
      const result = (await response.json()) as GithubBranchesResponse;
      setGithubBranches(result.branches);
    } catch {
      setGithubBranches([]);
    }
  };

  const trimmedName = name.trim();
  const trimmedImage = image.trim();
  const parsedPort = Number(containerPort);

  const sourceValid =
    sourceType === "manual" || (githubRepo !== null && githubBranch.trim().length > 0);
  const basicsValid = isValidAppName(trimmedName) && isValidImage(trimmedImage);
  const runtimeValid = isValidPort(parsedPort);

  const envVarsForValidation: WizardEnvVarInput[] = envRows.map((row) => ({
    key: row.key,
    value: row.value,
    isSecret: row.isSecret,
    enabled: row.enabled
  }));
  const envValidationError = validateEnvVars(envVarsForValidation);
  const environmentValid = envValidationError === null;

  const volumesForValidation: WizardVolumeInput[] = volumeRows.map((row) => ({
    containerPath: row.containerPath,
    volumeName: row.volumeName,
    readOnly: row.readOnly
  }));
  const storageValidationError = validateStorageMounts(volumesForValidation);
  const storageValid = storageValidationError === null;

  const stepValid = [
    sourceValid,
    basicsValid,
    runtimeValid,
    environmentValid,
    storageValid,
    true,
    true
  ][step];

  const buildBriefPayload = useCallback(
    (): BuildBriefRequestPayload => ({
      appName: trimmedName,
      image: trimmedImage,
      containerPort: parsedPort,
      runtime,
      description: description.trim() || undefined,
      startCommand: startCommand.trim() || undefined,
      healthCheckPath: healthCheckPath.trim() || undefined,
      environmentVariables: envRows
        .filter((row) => row.key)
        .map((row) => ({ key: row.key, isSecret: row.isSecret })),
      storageMounts: volumeRows
        .filter((row) => row.containerPath)
        .map((row) => ({ containerPath: row.containerPath, readOnly: row.readOnly }))
    }),
    [
      trimmedName,
      trimmedImage,
      parsedPort,
      runtime,
      description,
      startCommand,
      healthCheckPath,
      envRows,
      volumeRows
    ]
  );

  const fetchBrief = useCallback(async () => {
    if (!basicsValid || !runtimeValid) {
      return;
    }

    try {
      setBriefLoading(true);
      setBriefError("");
      setBriefCopied(false);

      const response = await fetch("/api/apps/wizard/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBriefPayload())
      });

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to generate the build brief")
        );
      }

      const result = (await response.json()) as BuildBriefResponse;
      setDomain(result.domain);
      setBrief(result.brief);
    } catch (error) {
      setBriefError(
        error instanceof Error ? error.message : "Unable to generate the build brief"
      );
    } finally {
      setBriefLoading(false);
    }
  }, [basicsValid, runtimeValid, buildBriefPayload]);

  useEffect(() => {
    if (open && step >= 5 && basicsValid && runtimeValid) {
      void fetchBrief();
    }
    // fetchBrief's own dependency list already captures every field that
    // should trigger a regeneration; re-running this effect on step/open
    // change alone is what makes entering the Domain or Review step
    // auto-generate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, open, basicsValid, runtimeValid, fetchBrief]);

  if (!open) {
    return null;
  }

  const addEnvRow = () => setEnvRows((rows) => [...rows, makeEnvRow()]);
  const updateEnvRow = (rowId: number, patch: Partial<EnvRow>) =>
    setEnvRows((rows) =>
      rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row))
    );
  const removeEnvRow = (rowId: number) =>
    setEnvRows((rows) => rows.filter((row) => row.rowId !== rowId));

  const addVolumeRow = () => setVolumeRows((rows) => [...rows, makeVolumeRow()]);
  const updateVolumeRow = (rowId: number, patch: Partial<VolumeRow>) =>
    setVolumeRows((rows) =>
      rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row))
    );
  const removeVolumeRow = (rowId: number) =>
    setVolumeRows((rows) => rows.filter((row) => row.rowId !== rowId));

  const goNext = () => setStep((current) => Math.min(current + 1, LAST_STEP));
  const goBack = () => setStep((current) => Math.max(current - 1, 0));

  const copyBrief = async () => {
    try {
      await navigator.clipboard.writeText(brief);
      setBriefCopied(true);
      window.setTimeout(() => setBriefCopied(false), 2000);
    } catch {
      setBriefError("Unable to copy to the clipboard. Select and copy the text manually.");
    }
  };

  const submitCreate = async () => {
    if (creating) {
      return;
    }

    try {
      setCreating(true);
      setCreateError("");
      setPostCreateNotice("");

      const payload: CreateAppWizardPayload = {
        name: trimmedName,
        image: trimmedImage,
        containerPort: parsedPort,
        restartPolicy,
        environmentVariables: envRows.map((row) => ({
          key: row.key,
          value: row.value,
          isSecret: row.isSecret,
          enabled: row.enabled
        })),
        storageMounts: volumeRows.map((row) => ({
          containerPath: row.containerPath,
          volumeName: row.volumeName ? row.volumeName : undefined,
          readOnly: row.readOnly
        }))
      };

      const response = await fetch("/api/apps/wizard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const result = (await response
        .json()
        .catch(() => ({}))) as Partial<CreateAppWizardResponse>;

      if (!response.ok || !result.success || !result.app) {
        throw new Error(result.message || "Unable to create app");
      }

      setCreatedApp(result.app);

      if (sourceType === "github" && githubRepo) {
        await linkAndOptionallyDeployGithubSource(result.app.id);
      }
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Unable to create app");
    } finally {
      setCreating(false);
    }
  };

  const linkAndOptionallyDeployGithubSource = async (appId: number) => {
    if (!githubRepo) {
      return;
    }

    try {
      const sourceResponse = await fetch(`/api/apps/${appId}/source`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryOwner: githubRepo.owner,
          repositoryName: githubRepo.name,
          branch: githubBranch,
          subdirectory: githubSubdirectory,
          deploymentMode: "dockerfile",
          dockerfilePath: "Dockerfile",
          buildContext: ".",
          containerPort: parsedPort,
          autoDeploy: false
        })
      });

      if (!sourceResponse.ok) {
        setPostCreateNotice(
          "The app was created, but its GitHub source could not be linked automatically. Link it from the Source tab."
        );
        return;
      }

      if (!deployAfterCreate) {
        setPostCreateNotice(
          "GitHub source linked. Use the Source tab's \"Deploy from GitHub\" button when you're ready."
        );
        return;
      }

      const deployResponse = await fetch(`/api/apps/${appId}/deploy/github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });

      if (!deployResponse.ok) {
        setPostCreateNotice(
          "GitHub source linked, but the first deployment could not be started automatically. Start it from the Source tab."
        );
        return;
      }

      setPostCreateNotice("GitHub source linked and the first deployment has started — check the Source tab for progress.");
    } catch {
      setPostCreateNotice(
        "The app was created, but its GitHub source could not be linked automatically. Link it from the Source tab."
      );
    }
  };

  const handleClose = () => {
    if (!creating) {
      onClose();
    }
  };

  const inheritedGlobals = globalVars.filter((variable) => variable.enabled);

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      <section
        className="form-modal wizard-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">New Deployment</p>
            <h2>{createdApp ? "App Created" : "Create App"}</h2>
          </div>

          <button
            className="close-button"
            type="button"
            disabled={creating}
            onClick={handleClose}
          >
            Close
          </button>
        </header>

        {!createdApp && (
          <div className="wizard-steps">
            {STEP_LABELS.map((label, index) => (
              <div
                key={label}
                className={`wizard-step-item ${
                  index === step ? "active" : index < step ? "done" : ""
                }`}
              >
                <span className="wizard-step-index">
                  {index < step ? "✓" : index + 1}
                </span>
                <span>{label}</span>
              </div>
            ))}
          </div>
        )}

        {createdApp ? (
          <div className="wizard-body">
            <div className="wizard-success">
              <span className="status-badge positive">Deployed</span>
              <h3 className="wizard-success-title">
                {createdApp.name} was created successfully.
              </h3>
              <p className="section-description">
                {createdApp.domain
                  ? createdApp.routingReady
                    ? `It will be reachable at https://${createdApp.domain} once DNS and routing finish propagating.`
                    : `Its domain (${createdApp.domain}) is assigned, but routing is not fully ready yet.`
                  : "No domain was assigned to this app."}
              </p>

              {postCreateNotice && <div className="notice-banner">{postCreateNotice}</div>}

              <dl className="wizard-review-grid">
                <div>
                  <dt>Environment variables</dt>
                  <dd>
                    {createdApp.environmentVariableCount} (
                    {createdApp.secretVariableCount} secret)
                  </dd>
                </div>
                <div>
                  <dt>Storage mounts</dt>
                  <dd>{createdApp.storageMountCount}</dd>
                </div>
                <div>
                  <dt>Container status</dt>
                  <dd>{createdApp.status}</dd>
                </div>
              </dl>

              <div className="form-actions wizard-success-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => resetWizard()}
                >
                  Create Another
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => onCreated(createdApp)}
                >
                  View App
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="wizard-body">
              {step === 0 && (
                <>
                  <div className="wizard-row-list">
                    <button
                      type="button"
                      className={`wizard-row repo-select-row ${sourceType === "manual" ? "selected" : ""}`}
                      onClick={() => setSourceType("manual")}
                    >
                      <strong>Configure manually</strong>
                      <span className="text-faint">Provide a Docker image directly — unchanged from before.</span>
                    </button>
                    <button
                      type="button"
                      className={`wizard-row repo-select-row ${sourceType === "github" ? "selected" : ""}`}
                      onClick={() => setSourceType("github")}
                    >
                      <strong>Deploy from GitHub</strong>
                      <span className="text-faint">
                        Build and deploy from a connected repository and branch.
                      </span>
                    </button>
                  </div>

                  {sourceType === "github" && (
                    <>
                      {!githubConnection?.connected ? (
                        <div className="warning-banner">
                          GitHub is not connected. Connect it from Settings, then reopen this
                          wizard — your progress on this step will not be lost if you cancel and
                          come straight back.
                        </div>
                      ) : !githubRepo ? (
                        <>
                          {githubReposError && <div className="error-banner">{githubReposError}</div>}
                          {githubReposLoading ? (
                            <div className="empty-state">Loading repositories...</div>
                          ) : githubRepos.length === 0 ? (
                            <div className="empty-state">No accessible repositories were found.</div>
                          ) : (
                            <div className="wizard-row-list">
                              {githubRepos.map((repo) => (
                                <button
                                  key={repo.id}
                                  type="button"
                                  className="wizard-row repo-select-row"
                                  onClick={() => void selectGithubRepo(repo)}
                                >
                                  <strong>{repo.fullName}</strong>
                                  <span className="text-faint">
                                    {repo.private ? "Private" : "Public"} · default: {repo.defaultBranch}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <p className="section-description">
                            Repository: <strong>{githubRepo.fullName}</strong>{" "}
                            <button
                              className="secondary-button compact"
                              type="button"
                              onClick={() => {
                                setGithubRepo(null);
                                setGithubBranches([]);
                              }}
                            >
                              Change
                            </button>
                          </p>

                          <label>
                            <span>Branch</span>
                            <select
                              className="wizard-select"
                              value={githubBranch}
                              onChange={(event) => setGithubBranch(event.target.value)}
                            >
                              {githubBranches.map((branch) => (
                                <option key={branch.name} value={branch.name}>
                                  {branch.name}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label>
                            <span>Subdirectory (optional)</span>
                            <input
                              value={githubSubdirectory}
                              onChange={(event) => setGithubSubdirectory(event.target.value)}
                              placeholder="."
                            />
                          </label>

                          <label className="checkbox-field">
                            <input
                              type="checkbox"
                              checked={deployAfterCreate}
                              onChange={(event) => setDeployAfterCreate(event.target.checked)}
                            />
                            <span>Create and deploy immediately (uncheck to just save the app and deploy later)</span>
                          </label>

                          <p className="section-description">
                            Continuing will use a temporary placeholder image (
                            <code>{GITHUB_PLACEHOLDER_IMAGE}</code>) until the first GitHub
                            deployment replaces it. Repository inspection and build strategy
                            selection happen from the Source tab after this app is created.
                          </p>
                        </>
                      )}
                    </>
                  )}
                </>
              )}

              {step === 1 && (
                <>
                  <label>
                    <span>App name</span>
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="hello-nginx"
                      pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                      minLength={2}
                      maxLength={40}
                      autoFocus
                    />
                    <small>Lowercase letters, numbers, and hyphens only.</small>
                  </label>

                  <label>
                    <span>Docker image</span>
                    <input
                      value={image}
                      onChange={(event) => setImage(event.target.value)}
                      placeholder="nginx:alpine"
                      disabled={sourceType === "github"}
                    />
                    <small>
                      {sourceType === "github"
                        ? "Set automatically until the first GitHub deployment replaces it."
                        : "Include a tag when possible, such as nginx:alpine."}
                    </small>
                  </label>

                  <label>
                    <span>Notes / description (optional)</span>
                    <input
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="What this app does, for your own reference"
                      maxLength={2000}
                    />
                    <small>
                      Shown to Claude in the build brief for context — not stored
                      anywhere else.
                    </small>
                  </label>

                  {trimmedName && (
                    <p className="section-description">
                      Container name will be <code>app-{trimmedName}</code>.
                    </p>
                  )}
                </>
              )}

              {step === 2 && (
                <>
                  <label>
                    <span>Container port</span>
                    <input
                      type="number"
                      value={containerPort}
                      onChange={(event) => setContainerPort(event.target.value)}
                      min="1"
                      max="65535"
                    />
                    <small>
                      The port the application listens on inside its container.
                    </small>
                  </label>

                  <label>
                    <span>Restart policy</span>
                    <select
                      className="wizard-select"
                      value={restartPolicy}
                      onChange={(event) =>
                        setRestartPolicy(event.target.value as RestartPolicy)
                      }
                    >
                      {RESTART_POLICY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span>Runtime / framework</span>
                    <select
                      className="wizard-select"
                      value={runtime}
                      onChange={(event) =>
                        setRuntime(event.target.value as BuildBriefRuntime)
                      }
                    >
                      {RUNTIME_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <small>Used only to tailor the Claude build brief below.</small>
                  </label>

                  <label>
                    <span>Startup command (optional)</span>
                    <input
                      value={startCommand}
                      onChange={(event) => setStartCommand(event.target.value)}
                      placeholder="node server.js"
                      maxLength={500}
                    />
                    <small>
                      Informational only — included in the build brief so Claude
                      can set the Dockerfile's ENTRYPOINT/CMD. This platform does
                      not override the container's command directly.
                    </small>
                  </label>

                  <label>
                    <span>Health check path (optional)</span>
                    <input
                      value={healthCheckPath}
                      onChange={(event) => setHealthCheckPath(event.target.value)}
                      placeholder="/health"
                      maxLength={255}
                    />
                    <small>Included as a suggestion in the build brief.</small>
                  </label>
                </>
              )}

              {step === 3 && (
                <>
                  <div className="env-scope-block">
                    <div className="env-scope-heading">
                      <h3>Inherited from Global</h3>
                    </div>
                    {inheritedGlobals.length === 0 ? (
                      <div className="empty-state">
                        No enabled global variables are currently configured.
                      </div>
                    ) : (
                      <div className="table-wrap">
                        <table className="env-table">
                          <thead>
                            <tr>
                              <th>Key</th>
                              <th>Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {inheritedGlobals.map((variable) => (
                              <tr key={variable.id}>
                                <td className="env-key-cell">
                                  <code>{variable.key}</code>
                                  {variable.isSecret && (
                                    <span className="status-badge warning compact">
                                      Secret
                                    </span>
                                  )}
                                </td>
                                <td className="env-value-cell">
                                  {variable.isSecret ? (
                                    <span className="masked-value">••••••••</span>
                                  ) : variable.hasValue ? (
                                    <code>{variable.value}</code>
                                  ) : (
                                    <span className="text-faint">Empty</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p className="section-description">
                      Global variables are inherited automatically. Add a
                      variable below with the same key to override it for this
                      app only.
                    </p>
                  </div>

                  <div className="env-scope-block">
                    <div className="env-scope-heading">
                      <h3>App-Specific Variables</h3>
                      <button
                        className="secondary-button compact"
                        type="button"
                        onClick={addEnvRow}
                      >
                        Add Variable
                      </button>
                    </div>

                    {envRows.length === 0 ? (
                      <div className="empty-state">
                        No app-specific variables yet. This app will use only
                        the inherited global variables.
                      </div>
                    ) : (
                      <div className="wizard-row-list">
                        {envRows.map((row) => (
                          <div className="wizard-row" key={row.rowId}>
                            <div className="wizard-row-fields">
                              <label>
                                <span>Key</span>
                                <input
                                  value={row.key}
                                  onChange={(event) =>
                                    updateEnvRow(row.rowId, { key: event.target.value })
                                  }
                                  placeholder="API_URL"
                                />
                              </label>
                              <label>
                                <span>Value</span>
                                <input
                                  type={row.isSecret ? "password" : "text"}
                                  value={row.value}
                                  onChange={(event) =>
                                    updateEnvRow(row.rowId, { value: event.target.value })
                                  }
                                  placeholder="https://example.com"
                                  autoComplete="off"
                                />
                              </label>
                            </div>

                            <div className="wizard-row-toggles">
                              <label className="checkbox-field">
                                <input
                                  type="checkbox"
                                  checked={row.isSecret}
                                  onChange={(event) =>
                                    updateEnvRow(row.rowId, {
                                      isSecret: event.target.checked
                                    })
                                  }
                                />
                                <span>Secret</span>
                              </label>
                              <label className="checkbox-field">
                                <input
                                  type="checkbox"
                                  checked={row.enabled}
                                  onChange={(event) =>
                                    updateEnvRow(row.rowId, {
                                      enabled: event.target.checked
                                    })
                                  }
                                />
                                <span>Enabled</span>
                              </label>
                            </div>

                            <div className="wizard-row-actions">
                              <button
                                className="danger-button compact"
                                type="button"
                                onClick={() => removeEnvRow(row.rowId)}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {envValidationError && (
                      <div className="error-banner">{envValidationError}</div>
                    )}
                  </div>
                </>
              )}

              {step === 4 && (
                <div className="env-scope-block">
                  <div className="env-scope-heading">
                    <h3>Persistent Storage</h3>
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={addVolumeRow}
                    >
                      Add Storage Mount
                    </button>
                  </div>
                  <p className="section-description">
                    Docker named volumes mounted into the container. Data
                    written outside these paths is lost on redeploy.
                  </p>

                  {volumeRows.length === 0 ? (
                    <div className="empty-state">
                      No storage mounts. This app's filesystem will be
                      disposable — fine for stateless apps.
                    </div>
                  ) : (
                    <div className="wizard-row-list">
                      {volumeRows.map((row) => (
                        <div className="wizard-row" key={row.rowId}>
                          <div className="wizard-row-fields">
                            <label>
                              <span>Container path</span>
                              <input
                                value={row.containerPath}
                                onChange={(event) =>
                                  updateVolumeRow(row.rowId, {
                                    containerPath: event.target.value
                                  })
                                }
                                placeholder="/data"
                              />
                              {row.containerPath &&
                                !isValidContainerPath(row.containerPath) && (
                                  <small className="text-faint">
                                    Must be an absolute path and cannot use a
                                    reserved system directory.
                                  </small>
                                )}
                            </label>
                            <label>
                              <span>Volume name (optional)</span>
                              <input
                                value={row.volumeName}
                                onChange={(event) =>
                                  updateVolumeRow(row.rowId, {
                                    volumeName: event.target.value
                                  })
                                }
                                placeholder="Auto-generated if blank"
                              />
                              {row.volumeName &&
                                !isValidVolumeName(row.volumeName) && (
                                  <small className="text-faint">
                                    Lowercase letters, numbers, hyphens, and
                                    underscores only.
                                  </small>
                                )}
                            </label>
                          </div>

                          <div className="wizard-row-toggles">
                            <label className="checkbox-field">
                              <input
                                type="checkbox"
                                checked={row.readOnly}
                                onChange={(event) =>
                                  updateVolumeRow(row.rowId, {
                                    readOnly: event.target.checked
                                  })
                                }
                              />
                              <span>Read-only</span>
                            </label>
                          </div>

                          <div className="wizard-row-actions">
                            <button
                              className="danger-button compact"
                              type="button"
                              onClick={() => removeVolumeRow(row.rowId)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {storageValidationError && (
                    <div className="error-banner">{storageValidationError}</div>
                  )}
                </div>
              )}

              {step === 5 && (
                <>
                  <dl className="wizard-review-grid">
                    <div>
                      <dt>Public domain</dt>
                      <dd>{domain ?? "Generating..."}</dd>
                    </div>
                    <div>
                      <dt>HTTPS</dt>
                      <dd>Automatic — the platform manages TLS certificates.</dd>
                    </div>
                    <div>
                      <dt>Routing</dt>
                      <dd>Configured automatically once the app is created.</dd>
                    </div>
                    <div>
                      <dt>Docker network</dt>
                      <dd>Managed by the platform — no manual configuration.</dd>
                    </div>
                  </dl>
                  <p className="section-description">
                    There's nothing to configure here — public HTTPS and domain
                    routing are set up automatically for every app.
                  </p>
                </>
              )}

              {step === 6 && (
                <>
                  <dl className="wizard-review-grid">
                    <div>
                      <dt>Source</dt>
                      <dd>{sourceType === "github" && githubRepo ? githubRepo.fullName : "Manual"}</dd>
                    </div>
                    {sourceType === "github" && githubRepo && (
                      <div>
                        <dt>Branch</dt>
                        <dd>{githubBranch}</dd>
                      </div>
                    )}
                    <div>
                      <dt>App name</dt>
                      <dd>{trimmedName}</dd>
                    </div>
                    <div>
                      <dt>Image</dt>
                      <dd>{trimmedImage}</dd>
                    </div>
                    <div>
                      <dt>Container port</dt>
                      <dd>{containerPort}</dd>
                    </div>
                    <div>
                      <dt>Restart policy</dt>
                      <dd>{restartPolicy}</dd>
                    </div>
                    <div>
                      <dt>Domain</dt>
                      <dd>{domain ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Environment variables</dt>
                      <dd>
                        {envRows.length} (
                        {envRows.filter((row) => row.isSecret).length} secret)
                      </dd>
                    </div>
                    <div>
                      <dt>Storage mounts</dt>
                      <dd>{volumeRows.length}</dd>
                    </div>
                  </dl>

                  {volumeRows.length === 0 && (
                    <div className="warning-banner">
                      No persistent storage is configured — any data this app
                      writes will be lost on the next redeploy.
                    </div>
                  )}

                  <div className="env-scope-block">
                    <div className="env-scope-heading">
                      <h3>Claude Build Brief</h3>
                      <button
                        className="secondary-button compact"
                        type="button"
                        disabled={briefLoading}
                        onClick={() => void fetchBrief()}
                      >
                        {briefLoading ? "Generating..." : "Regenerate"}
                      </button>
                    </div>
                    <p className="section-description">
                      Copy this into a conversation with Claude to prepare your
                      application's code for this platform. Nothing is sent to
                      Claude automatically, and no secret values are ever
                      included.
                    </p>

                    {briefError && <div className="error-banner">{briefError}</div>}

                    <div className="brief-box">
                      <pre>
                        {brief || (briefLoading ? "Generating build brief..." : "")}
                      </pre>
                      <div className="brief-box-actions">
                        <button
                          className="secondary-button compact"
                          type="button"
                          disabled={!brief}
                          onClick={() => void copyBrief()}
                        >
                          {briefCopied ? "Copied!" : "Copy Build Brief"}
                        </button>
                      </div>
                    </div>
                  </div>

                  {createError && <div className="error-banner">{createError}</div>}
                </>
              )}
            </div>

            <div className="wizard-footer">
              <button
                className="secondary-button"
                type="button"
                disabled={step === 0 || creating}
                onClick={goBack}
              >
                Back
              </button>

              <div className="wizard-footer-right">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={creating}
                  onClick={handleClose}
                >
                  Cancel
                </button>

                {step < LAST_STEP ? (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!stepValid}
                    onClick={goNext}
                  >
                    Continue
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={creating || !basicsValid || !runtimeValid || !sourceValid}
                    onClick={() => void submitCreate()}
                  >
                    {creating
                      ? "Creating..."
                      : sourceType === "github" && deployAfterCreate
                        ? "Create and Deploy"
                        : "Create App"}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
