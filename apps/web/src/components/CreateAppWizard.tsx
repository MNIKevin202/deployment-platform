import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiError,
  BuildBriefRequestPayload,
  BuildBriefResponse,
  BuildBriefRuntime,
  BuildStrategy,
  CreateAppWizardPayload,
  CreateAppWizardResponse,
  CreatedAppSummary,
  DeploymentMode,
  GithubBranchesResponse,
  GithubConnectionInfo,
  InspectSourceResponse,
  MaskedGlobalEnvVar,
  PortProtocol,
  RepositoryInspectionResult,
  RestartPolicy,
  SourceBranch,
  SourceRepository,
  SuggestPortResponse,
  WizardEnvVarInput,
  WizardVolumeInput,
  InstallProgress
} from "../types/api";
import {
  isValidAppName,
  isValidContainerPath,
  isValidCustomDomain,
  isValidImage,
  isValidPort,
  isValidVolumeName,
  sanitizeAppName,
  validateEnvVars,
  validateStorageMounts
} from "../lib/wizardValidation";
import BulkEnvVarDialog from "./BulkEnvVarDialog";
import InstallProgressModal from "./InstallProgressModal";
import {
  companionAppName,
  generateSecret,
  resolveTemplatePlaceholders,
  type AppTemplate,
  type TemplateCompanion
} from "../lib/appTemplates";
import { useGithubRepositories } from "../hooks/useGithubRepositories";
import { PORT_SOURCE_LABELS, PROJECT_TYPE_LABELS, STRATEGY_INFO } from "./SourcePanel";

interface CreateAppWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (app: CreatedAppSummary) => void;
  /** When set, pre-fills the manual-image flow from a catalog template. */
  initialTemplate?: AppTemplate | null;
  /**
   * An optional model to download right after a template that supports it
   * finishes deploying (Blueprint). Chosen in the template gallery; empty
   * means "deploy without downloading a model".
   */
  initialModel?: string | null;
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

// Internal placeholder only — never the deployed application. App
// creation still requires a pullable image to exist right away; the real
// image is built and swapped in by the first GitHub deployment, triggered
// either immediately ("Create and deploy") or later from the app's
// Source tab ("Save application without deploying"). The operator never
// needs to know this value — it is not surfaced anywhere in this
// component's own UI, only in this comment.
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

interface PortRow {
  rowId: number;
  hostPort: string;
  containerPort: string;
  protocol: PortProtocol;
}

let nextRowId = 1;

function makeEnvRow(): EnvRow {
  return { rowId: nextRowId++, key: "", value: "", isSecret: false, enabled: true };
}

function makeVolumeRow(): VolumeRow {
  return { rowId: nextRowId++, containerPath: "", volumeName: "", readOnly: false };
}

function makePortRow(): PortRow {
  return { rowId: nextRowId++, hostPort: "", containerPort: "", protocol: "tcp" };
}

/** null when the rows are a valid published-port set, else an error message. */
function validatePortRows(rows: PortRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const host = Number(row.hostPort);
    const container = Number(row.containerPort);
    if (!row.hostPort.trim() || !row.containerPort.trim()) {
      return "Every published port needs both a host and a container port.";
    }
    if (
      !Number.isInteger(host) ||
      !Number.isInteger(container) ||
      host < 1 ||
      host > 65535 ||
      container < 1 ||
      container > 65535
    ) {
      return "Ports must be whole numbers between 1 and 65535.";
    }
    const key = `${host}/${row.protocol}`;
    if (seen.has(key)) {
      return `Host port ${host}/${row.protocol} is listed more than once.`;
    }
    seen.add(key);
  }
  return null;
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

const NETWORK_RETRY_DELAY_MS = 1500;

/**
 * Posts the wizard create payload with a bounded, idempotency-key-safe
 * retry.
 *
 * A network-level failure (fetch() itself rejecting — no HTTP response was
 * ever received) is retried exactly once, resending the SAME body under the
 * SAME Idempotency-Key. That is what makes the retry safe rather than a
 * second create: if the original request actually reached and was processed
 * by the server before the connection dropped, the API recognizes the
 * repeated key and replays that result instead of creating a second app or
 * reporting a misleading "already exists" error. This directly covers app
 * creation's own route-reconciliation step restarting the Caddy container
 * that is, at that moment, still proxying this very request.
 *
 * An HTTP response — even an error one — is authoritative and is never
 * retried: the server has definitively answered, so retrying could only
 * duplicate a real duplicate-name rejection or a validation failure.
 */
async function postAppCreateWithRetry(
  payload: CreateAppWizardPayload,
  idempotencyKey: string,
  installId: string
): Promise<Response> {
  const attempt = () =>
    fetch("/api/apps/wizard", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        // Ties this request to the progress stream the caller has already
        // opened for the same id, so no early update can be missed.
        "X-Install-Id": installId
      },
      body: JSON.stringify(payload)
    });

  try {
    return await attempt();
  } catch {
    await new Promise((resolve) => window.setTimeout(resolve, NETWORK_RETRY_DELAY_MS));
    return attempt();
  }
}

type SourceType = "manual" | "github";

export default function CreateAppWizard({
  open,
  onClose,
  onCreated,
  initialTemplate,
  initialModel
}: CreateAppWizardProps) {
  const [step, setStep] = useState(0);

  const [sourceType, setSourceType] = useState<SourceType>("manual");

  const [githubConnection, setGithubConnection] = useState<GithubConnectionInfo | null>(null);
  const [githubAppConfigured, setGithubAppConfigured] = useState(false);
  const [githubAppInstalled, setGithubAppInstalled] = useState(false);
  const [githubRepo, setGithubRepo] = useState<SourceRepository | null>(null);
  const [githubBranches, setGithubBranches] = useState<SourceBranch[]>([]);
  const [githubBranch, setGithubBranch] = useState("");
  const [githubSubdirectory, setGithubSubdirectory] = useState(".");
  const [deployAfterCreate, setDeployAfterCreate] = useState(true);

  const [githubInspection, setGithubInspection] = useState<RepositoryInspectionResult | null>(null);
  const [githubInspecting, setGithubInspecting] = useState(false);
  const [githubInspectError, setGithubInspectError] = useState("");

  // The operator's own explicit strategy choice — inspection's
  // recommendation is advisory only, same rule as the Edit Source flow
  // (SourcePanel.tsx). githubStrategyManuallySet tracks whether the
  // operator has actively chosen a strategy; once true, a later
  // inspection rerun must never silently replace it.
  const [githubSelectedStrategy, setGithubSelectedStrategyState] = useState<Exclude<
    BuildStrategy,
    "unsupported"
  > | null>(null);
  const [githubStrategyManuallySet, setGithubStrategyManuallySet] = useState(false);
  const [githubDockerfilePath, setGithubDockerfilePath] = useState("Dockerfile");
  const [githubBuildContext, setGithubBuildContext] = useState(".");

  const chooseGithubStrategy = (strategy: Exclude<BuildStrategy, "unsupported">) => {
    setGithubSelectedStrategyState(strategy);
    setGithubStrategyManuallySet(true);
  };

  const [name, setName] = useState("");
  const [image, setImage] = useState("");

  const [containerPort, setContainerPort] = useState("3000");
  // Mirrors SourcePanel.tsx's containerPort tracking: null/"manual" both
  // mean "not a detection result" — a fresh detection sets these together
  // with containerPort, and any manual edit immediately marks it "manual"
  // so a later inspection rerun knows not to silently overwrite it.
  const [containerPortSource, setContainerPortSource] = useState<string | null>(null);
  const [containerPortConfidence, setContainerPortConfidence] = useState<string | null>(null);
  // Unlike SourcePanel (whose port field starts empty), this wizard's port
  // field keeps a "3000" default for the manual/prebuilt-image flow, which
  // has no detection to prefer — so an emptiness check can't tell "still at
  // the default" apart from "operator typed 3000 on purpose". Track it
  // explicitly instead, same pattern as githubStrategyManuallySet.
  const [containerPortManuallySet, setContainerPortManuallySet] = useState(false);
  const [generatingPort, setGeneratingPort] = useState(false);
  const [restartPolicy, setRestartPolicy] = useState<RestartPolicy>("unless-stopped");
  const [memoryLimit, setMemoryLimit] = useState("");
  const [cpuLimit, setCpuLimit] = useState("");
  const [runtime, setRuntime] = useState<BuildBriefRuntime>("docker");
  const [description, setDescription] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [healthCheckPath, setHealthCheckPath] = useState("");

  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [showBulkEnv, setShowBulkEnv] = useState(false);
  const [volumeRows, setVolumeRows] = useState<VolumeRow[]>([]);
  const [portRows, setPortRows] = useState<PortRow[]>([]);

  const [globalVars, setGlobalVars] = useState<MaskedGlobalEnvVar[]>([]);
  const [globalVarsLoaded, setGlobalVarsLoaded] = useState(false);

  // Extra services a multi-service template deploys with this app. Held as
  // template definitions rather than resolved payloads because their real
  // app names depend on the name the operator settles on, which they can
  // still change on the Basics step.
  const [templateCompanions, setTemplateCompanions] = useState<TemplateCompanion[]>([]);
  const [pendingModel, setPendingModel] = useState<string | null>(null);

  const [routingChoice, setRoutingChoice] = useState<"public" | "internal">("public");
  const [domainChoice, setDomainChoice] = useState<"default" | "custom">("default");
  const [customDomain, setCustomDomain] = useState("");
  const [domain, setDomain] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState("");
  const [briefCopied, setBriefCopied] = useState(false);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);
  const [showInstallProgress, setShowInstallProgress] = useState(false);
  const progressSourceRef = useRef<EventSource | null>(null);
  const [createdApp, setCreatedApp] = useState<CreatedAppSummary | null>(null);
  const [postCreateNotice, setPostCreateNotice] = useState("");

  // A ref, not the `creating` state, is what actually prevents a second
  // request. State updates are asynchronous and batched — two submit
  // triggers that both read `creating` before either re-render sees it flip
  // (a fast double click, or Enter-while-focused firing right after a mouse
  // click) can both pass a state-only guard. A ref mutation is synchronous
  // and visible to the very next line of JS, so it closes that race
  // regardless of how the second trigger arrives (click, keyboard Enter on
  // the focused button, or a duplicate handler).
  const submitLockRef = useRef(false);

  const resetWizard = useCallback(() => {
    setStep(0);
    setSourceType("manual");
    setGithubRepo(null);
    setGithubBranch("");
    setGithubSubdirectory(".");
    setDeployAfterCreate(true);
    setGithubInspection(null);
    setGithubInspecting(false);
    setGithubInspectError("");
    setGithubSelectedStrategyState(null);
    setGithubStrategyManuallySet(false);
    setGithubDockerfilePath("Dockerfile");
    setGithubBuildContext(".");
    setName("");
    setImage("");
    setContainerPort("3000");
    setContainerPortSource(null);
    setContainerPortConfidence(null);
    setContainerPortManuallySet(false);
    setRestartPolicy("unless-stopped");
    setRuntime("docker");
    setDescription("");
    setStartCommand("");
    setHealthCheckPath("");
    setEnvRows([]);
    setVolumeRows([]);
    setPortRows([]);
    setTemplateCompanions([]);
    setPendingModel(null);
    setRoutingChoice("public");
    setDomainChoice("default");
    setCustomDomain("");
    setDomain(null);
    setBrief("");
    setBriefError("");
    setBriefCopied(false);
    setCreateError("");
    setCreatedApp(null);
    setPostCreateNotice("");
    setInstallProgress(null);
    setShowInstallProgress(false);
    progressSourceRef.current?.close();
    progressSourceRef.current = null;
    submitLockRef.current = false;
  }, []);

  // A wizard unmounted mid-install must not leave its stream open.
  useEffect(
    () => () => {
      progressSourceRef.current?.close();
      progressSourceRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (open) {
      resetWizard();
    }
  }, [open, resetWizard]);

  // Seed the manual-image flow from a catalog template. Runs after the reset
  // effect above (declared later), so it overrides the cleared defaults.
  useEffect(() => {
    if (!open || !initialTemplate) {
      return;
    }
    setSourceType("manual");
    setName(sanitizeAppName(initialTemplate.suggestedName));
    setImage(initialTemplate.image);
    setContainerPort(String(initialTemplate.containerPort));
    setContainerPortManuallySet(true);
    setEnvRows(
      initialTemplate.env.map((envVar) => ({
        rowId: nextRowId++,
        key: envVar.key,
        value:
          envVar.generate === "password"
            ? generateSecret(envVar.generateLength ?? 24)
            : envVar.value ?? "",
        isSecret: Boolean(envVar.secret),
        enabled: true
      }))
    );
    setVolumeRows(
      (initialTemplate.volumes ?? []).map((containerPath) => ({
        rowId: nextRowId++,
        containerPath,
        volumeName: "",
        readOnly: false
      }))
    );
    setPortRows(
      (initialTemplate.publishedPorts ?? []).map((port) => ({
        rowId: nextRowId++,
        hostPort: String(port.hostPort),
        containerPort: String(port.containerPort),
        protocol: port.protocol
      }))
    );
    setTemplateCompanions(initialTemplate.companions ?? []);
    setPendingModel(initialModel ?? null);
    // Game/raw-TCP servers have no meaningful HTTP route — a template can opt
    // out of a public domain so it's reached purely via its published port.
    if (initialTemplate.internalOnly) {
      setRoutingChoice("internal");
    }
    setStep(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTemplate, initialModel]);

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

    void (async () => {
      try {
        const response = await fetch("/api/github/installations");
        if (!response.ok || cancelled) return;
        const result = (await response.json()) as {
          configured: boolean;
          installations: { installationId: number }[];
        };
        if (!cancelled) {
          setGithubAppConfigured(result.configured);
          setGithubAppInstalled(result.installations.length > 0);
        }
      } catch {
        // Non-critical — the Source step falls back to the PAT connection
        // state and the "Connect GitHub" prompt still degrades gracefully.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Ready via either path: the automated GitHub App installation (primary)
  // or the advanced manual PAT (fallback) — the wizard doesn't care which
  // one produced a usable token, only whether repositories are reachable.
  const githubReady = githubAppInstalled || (githubConnection?.connected ?? false);

  // The shared loader (also used by RepositoriesPage) walks every page
  // automatically and exposes a search filter over the complete,
  // deduplicated collection — so a repository outside GitHub's first page
  // is always reachable here, not just on the separate Repositories page.
  // Enabled as soon as GitHub source + a usable credential are both picked
  // (not gated on the current step) so the list stays loaded, without a
  // refetch/flicker, if the operator steps forward and back.
  const {
    filteredRepos: githubRepos,
    searchQuery: githubRepoSearch,
    setSearchQuery: setGithubRepoSearch,
    loading: githubReposLoading,
    loadingMore: githubReposLoadingMore,
    error: githubReposError,
    rateLimited: githubReposRateLimited,
    repos: githubReposAll
  } = useGithubRepositories(open && sourceType === "github" && githubReady);

  const selectGithubRepo = async (repo: SourceRepository) => {
    setGithubRepo(repo);
    setGithubBranch(repo.defaultBranch);
    // Slugify the repo-derived name too — a repo like "ClovaChatWebsite"
    // must become a valid lowercase app name, matching what typing produces.
    setName((current) => current || sanitizeAppName(repo.name));
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

  // Stale-inspection handling: any change to repository, branch, or
  // subdirectory invalidates a prior inspection result — it must never be
  // reused for a different selection. A manual strategy choice tied to
  // that same now-stale combination resets back to "follow the
  // recommendation" too.
  useEffect(() => {
    setGithubInspection(null);
    setGithubInspectError("");
    setGithubSelectedStrategyState(null);
    setGithubStrategyManuallySet(false);
    // A stale detection's source/confidence must never be shown against a
    // different repository/branch/subdirectory — the port value itself is
    // left alone (same as the strategy fields), matching SourcePanel.
    setContainerPortSource(null);
    setContainerPortConfidence(null);
    setContainerPortManuallySet(false);
  }, [githubRepo?.fullName, githubBranch, githubSubdirectory]);

  const runGithubInspect = async () => {
    if (!githubRepo || !githubBranch) {
      return;
    }

    try {
      setGithubInspecting(true);
      setGithubInspectError("");

      const response = await fetch(
        `/api/integrations/github/repositories/${githubRepo.owner}/${githubRepo.name}/inspect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch: githubBranch, subdirectory: githubSubdirectory })
        }
      );

      const result = (await response.json().catch(() => ({}))) as Partial<InspectSourceResponse>;

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to inspect repository");
      }

      setGithubInspection(result.inspection ?? null);

      // Inspection recommendations are advisory: only auto-apply the
      // recommendation while the operator hasn't made an explicit choice
      // of their own.
      if (!githubStrategyManuallySet) {
        const recommended = result.inspection?.recommendedStrategy;
        if (recommended && recommended !== "unsupported") {
          setGithubSelectedStrategyState(recommended);
        }
      }

      // Prefill the container port only from a high-confidence, single,
      // unambiguous detection, and only if the operator hasn't already
      // typed a value — same rule as SourcePanel.tsx's Edit Source flow.
      // This is the fix for repositories whose real listening port (e.g.
      // a Dockerfile's EXPOSE) doesn't match the platform's placeholder
      // default: without this, nothing here ever read portDetection, so
      // the port field just sat at a generic default until the operator
      // happened to notice and correct it themselves.
      const portDetection = result.inspection?.portDetection;
      if (
        portDetection &&
        portDetection.detectedPort !== null &&
        portDetection.confidence === "high" &&
        !containerPortManuallySet
      ) {
        setContainerPort(String(portDetection.detectedPort));
        setContainerPortSource(portDetection.source);
        setContainerPortConfidence(portDetection.confidence);
      }
    } catch (error) {
      setGithubInspectError(error instanceof Error ? error.message : "Unable to inspect repository");
      setGithubInspection(null);
    } finally {
      setGithubInspecting(false);
    }
  };

  // Inspect automatically as soon as a repository and branch are chosen — no
  // manual "Inspect" click needed. Keyed on the selection identity so it runs
  // once per repo/branch choice; the stale-clear effect above has already run
  // for the same change, so this always inspects the current selection.
  // (Subdirectory tweaks still use the manual Re-inspect button.)
  useEffect(() => {
    if (githubRepo && githubBranch) {
      void runGithubInspect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [githubRepo?.fullName, githubBranch]);

  const trimmedName = name.trim();
  const trimmedImage = image.trim();
  const parsedPort = Number(containerPort);

  const githubNodejsStartScriptMissing =
    githubSelectedStrategy === "nodejs" && githubInspection?.packageJson?.hasStartScript === false;

  const sourceValid =
    sourceType === "manual" ||
    (githubRepo !== null &&
      githubBranch.trim().length > 0 &&
      githubInspection !== null &&
      githubInspection.supported &&
      githubSelectedStrategy !== null &&
      !githubNodejsStartScriptMissing &&
      (githubSelectedStrategy !== "dockerfile" ||
        (githubDockerfilePath.trim().length > 0 && githubBuildContext.trim().length > 0)));
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
  const portsValidationError = validatePortRows(portRows);

  const trimmedCustomDomain = customDomain.trim();
  const domainValid =
    routingChoice === "internal" ||
    domainChoice === "default" ||
    isValidCustomDomain(trimmedCustomDomain);

  const stepValid = [
    sourceValid,
    basicsValid,
    runtimeValid,
    environmentValid,
    storageValid && portsValidationError === null,
    domainValid,
    true
  ][step];

  const briefInternalOnly = routingChoice === "internal";
  const briefCustomDomain =
    routingChoice === "public" && domainChoice === "custom" ? trimmedCustomDomain : undefined;

  const buildBriefPayload = useCallback(
    (): BuildBriefRequestPayload => ({
      appName: trimmedName,
      image: trimmedImage,
      containerPort: parsedPort,
      internalOnly: briefInternalOnly,
      customDomain: briefCustomDomain || undefined,
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
      briefInternalOnly,
      briefCustomDomain,
      runtime,
      description,
      startCommand,
      healthCheckPath,
      envRows,
      volumeRows
    ]
  );

  const fetchBrief = useCallback(async () => {
    if (!basicsValid || !runtimeValid || !domainValid) {
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
    if (open && step >= 5 && basicsValid && runtimeValid && domainValid) {
      void fetchBrief();
    }
    // fetchBrief's own dependency list already captures every field that
    // should trigger a regeneration; re-running this effect on step/open
    // change alone is what makes entering the Domain or Review step
    // auto-generate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, open, basicsValid, runtimeValid, domainValid, fetchBrief]);

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

  // Merge bulk-pasted variables into the rows: existing keys are updated in
  // place, new keys are appended — matching BulkEnvVarDialog's own wording.
  const applyBulkEnv = (variables: { key: string; value: string; isSecret: boolean }[]) => {
    setEnvRows((rows) => {
      const next = [...rows];
      for (const variable of variables) {
        const index = next.findIndex((row) => row.key === variable.key);
        if (index >= 0) {
          next[index] = { ...next[index], value: variable.value, isSecret: variable.isSecret, enabled: true };
        } else {
          next.push({
            rowId: nextRowId++,
            key: variable.key,
            value: variable.value,
            isSecret: variable.isSecret,
            enabled: true
          });
        }
      }
      return next;
    });
    setShowBulkEnv(false);
  };

  const existingEnvSecrets = new Map<string, boolean>();
  for (const row of envRows) {
    if (row.key) {
      existingEnvSecrets.set(row.key, row.isSecret);
    }
  }

  const addVolumeRow = () => setVolumeRows((rows) => [...rows, makeVolumeRow()]);
  const updateVolumeRow = (rowId: number, patch: Partial<VolumeRow>) =>
    setVolumeRows((rows) =>
      rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row))
    );
  const removeVolumeRow = (rowId: number) =>
    setVolumeRows((rows) => rows.filter((row) => row.rowId !== rowId));

  const addPortRow = () => setPortRows((rows) => [...rows, makePortRow()]);
  const updatePortRow = (rowId: number, patch: Partial<PortRow>) =>
    setPortRows((rows) =>
      rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row))
    );
  const removePortRow = (rowId: number) =>
    setPortRows((rows) => rows.filter((row) => row.rowId !== rowId));

  // Ask the server for a container port not already assigned to another app.
  const generatePort = async () => {
    try {
      setGeneratingPort(true);
      const response = await fetch("/api/ports/suggest");
      if (!response.ok) {
        return;
      }
      const result = (await response.json()) as SuggestPortResponse;
      if (result?.port) {
        setContainerPort(String(result.port));
        setContainerPortSource("manual");
        setContainerPortConfidence(null);
        setContainerPortManuallySet(true);
      }
    } catch {
      // Non-critical: leave the current port untouched on any failure.
    } finally {
      setGeneratingPort(false);
    }
  };

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
    // The ref check-and-set below is the actual guard against a second
    // request — see submitLockRef's declaration for why it has to be a ref
    // and not the `creating` state.
    if (submitLockRef.current) {
      return;
    }
    submitLockRef.current = true;

    try {
      setCreating(true);
      setCreateError("");
      setPostCreateNotice("");
      setInstallProgress(null);
      setShowInstallProgress(true);

      const payload: CreateAppWizardPayload = {
        name: trimmedName,
        image: trimmedImage,
        containerPort: parsedPort,
        restartPolicy,
        memoryLimitMb: memoryLimit.trim() ? Number(memoryLimit) : null,
        cpuLimit: cpuLimit.trim() ? Number(cpuLimit) : null,
        internalOnly: routingChoice === "internal",
        customDomain: briefCustomDomain || undefined,
        environmentVariables: envRows.map((row) => ({
          key: row.key,
          // Companion references are resolved here, at submit time, rather
          // than when the template was selected — the operator can still
          // rename the app on the Basics step, and the companion's real
          // container name follows that name.
          value: resolveTemplatePlaceholders(row.value, trimmedName, templateCompanions),
          isSecret: row.isSecret,
          enabled: row.enabled
        })),
        storageMounts: volumeRows.map((row) => ({
          containerPath: row.containerPath,
          volumeName: row.volumeName ? row.volumeName : undefined,
          readOnly: row.readOnly
        })),
        publishedPorts: portRows.map((row) => ({
          hostPort: Number(row.hostPort),
          containerPort: Number(row.containerPort),
          protocol: row.protocol
        })),
        ...(templateCompanions.length > 0
          ? {
              companions: templateCompanions.map((companion) => ({
                name: companionAppName(trimmedName, companion),
                image: companion.image,
                containerPort: companion.containerPort,
                restartPolicy,
                internalOnly: companion.internalOnly ?? true,
                environmentVariables: (companion.env ?? []).map((envVar) => ({
                  key: envVar.key,
                  value:
                    envVar.generate === "password"
                      ? generateSecret(envVar.generateLength ?? 24)
                      : resolveTemplatePlaceholders(
                          envVar.value ?? "",
                          trimmedName,
                          templateCompanions
                        ),
                  isSecret: Boolean(envVar.secret),
                  enabled: true
                })),
                storageMounts: (companion.volumes ?? []).map((containerPath) => ({
                  containerPath,
                  readOnly: false
                }))
              }))
            }
          : {})
      };

      // One key for this whole attempt, including the automatic
      // network-error retry inside postAppCreateWithRetry — never
      // regenerated for a retry of the SAME attempt, always fresh for a NEW
      // one (the next time this function runs, e.g. a later click after a
      // real failure).
      const idempotencyKey = crypto.randomUUID();
      const installId = crypto.randomUUID();

      // Subscribe BEFORE posting: the server creates the progress job when
      // the POST arrives, so opening the stream first is what guarantees
      // the very first stage change is seen rather than raced.
      openProgressStream(installId);

      const response = await postAppCreateWithRetry(payload, idempotencyKey, installId);

      const result = (await response
        .json()
        .catch(() => ({}))) as Partial<CreateAppWizardResponse>;

      if (!response.ok || !result.success || !result.app) {
        throw new Error(result.message || "Unable to create app");
      }

      setCreatedApp(result.app);

      if (pendingModel) {
        await startInitialModelDownload(result.app.id, pendingModel);
      }

      if (sourceType === "github" && githubRepo) {
        await linkAndOptionallyDeployGithubSource(result.app.id);
      }
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Unable to create app");
    } finally {
      setCreating(false);
      submitLockRef.current = false;
      closeProgressStream();
    }
  };

  /**
   * Opens the install progress stream. Kept deliberately non-fatal: if SSE
   * can't be established, the install itself is unaffected — the dialog
   * just shows no percentage, and the create request's own response
   * remains the source of truth for success or failure.
   */
  const openProgressStream = (installId: string) => {
    closeProgressStream();

    try {
      const source = new EventSource(`/api/apps/wizard/install/${installId}/progress`);
      progressSourceRef.current = source;

      source.addEventListener("progress", (event) => {
        try {
          setInstallProgress(JSON.parse((event as MessageEvent).data) as InstallProgress);
        } catch {
          // A malformed frame is skipped rather than breaking the dialog.
        }
      });

      // The browser's EventSource retries on its own; nothing to do here
      // beyond not treating a transient drop as an install failure.
      source.addEventListener("error", () => {});
    } catch {
      progressSourceRef.current = null;
    }
  };

  const closeProgressStream = () => {
    progressSourceRef.current?.close();
    progressSourceRef.current = null;
  };

  /**
   * Kicks off the optional first model download after the app itself is
   * already created and running. Deliberately best-effort: a model download
   * is a long, retryable background task, so a failure here reports a
   * notice and leaves a perfectly good app in place rather than failing the
   * install. The app's Blueprint tab can retry it at any time.
   */
  const startInitialModelDownload = async (appId: number, model: string) => {
    try {
      const response = await fetch(`/api/apps/${appId}/blueprint/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model })
      });

      if (!response.ok) {
        setPostCreateNotice(
          `The app was created, but the download of "${model}" could not be started. Start it from the app's Blueprint tab.`
        );
        return;
      }

      setPostCreateNotice(
        `Downloading "${model}" in the background — follow its progress on the app's Blueprint tab. This can take several minutes.`
      );
    } catch {
      setPostCreateNotice(
        `The app was created, but the download of "${model}" could not be started. Start it from the app's Blueprint tab.`
      );
    }
  };

  const linkAndOptionallyDeployGithubSource = async (appId: number) => {
    if (!githubRepo) {
      return;
    }

    // deploymentMode controls whether the source-save step checks for a
    // Dockerfile — driven by the operator's SELECTED strategy (inspection
    // recommendations are advisory, not mandatory), not automatically by
    // whatever inspection happened to detect.
    const deploymentMode: DeploymentMode = githubSelectedStrategy === "dockerfile" ? "dockerfile" : "prebuilt-image";

    try {
      const sourceResponse = await fetch(`/api/apps/${appId}/source`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryOwner: githubRepo.owner,
          repositoryName: githubRepo.name,
          branch: githubBranch,
          subdirectory: githubSubdirectory,
          deploymentMode,
          dockerfilePath: githubDockerfilePath,
          buildContext: githubBuildContext,
          selectedStrategy: githubSelectedStrategy,
          containerPort: parsedPort,
          containerPortSource: containerPortSource ?? "manual",
          containerPortConfidence: containerPortConfidence ?? undefined,
          // New apps default to auto-deploy on; it can be toggled off later
          // from the Source tab.
          autoDeploy: true
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
    // No onClick here, deliberately: this wizard can hold several steps of
    // typed-in configuration, and an accidental click on the backdrop should
    // never silently discard it. Closing goes through the explicit Close /
    // Cancel controls only (both call handleClose below).
    <div className="modal-backdrop">
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
                {createdApp.internalOnly
                  ? "This app is internal only — it has no public domain, route, or TLS certificate. Other apps can reach it on the platform's private network by its container name."
                  : createdApp.domain
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
                      {!githubReady ? (
                        <div className="warning-banner">
                          <p>
                            GitHub is not connected yet. Authorize repository access through GitHub,
                            then this step will pick up automatically.
                          </p>
                          {githubAppConfigured ? (
                            <a
                              className="primary-button"
                              href="/api/github/connect"
                              onClick={() => {
                                // Connecting is a real browser navigation
                                // (GitHub -> our callback -> a fresh page
                                // load), which discards this component's
                                // in-memory state no matter what. This is
                                // the one piece of progress worth
                                // preserving across that: App.tsx checks
                                // for it after the redirect back and
                                // reopens the wizard automatically instead
                                // of leaving the operator to find their way
                                // back to Apps -> Create App themselves.
                                window.sessionStorage.setItem("dp_resume_create_app_wizard", "1");
                              }}
                            >
                              Connect GitHub
                            </a>
                          ) : (
                            <p className="text-faint">
                              The GitHub App is not configured on this server yet. Use the advanced
                              personal-access-token option on the Repositories page instead, or ask
                              an operator to finish GitHub App setup.
                            </p>
                          )}
                        </div>
                      ) : !githubRepo ? (
                        <>
                          <label>
                            <span>Search repositories</span>
                            <input
                              value={githubRepoSearch}
                              onChange={(event) => setGithubRepoSearch(event.target.value)}
                              placeholder="Search by name, owner, or owner/repo..."
                              disabled={githubReposLoading && githubReposAll.length === 0}
                            />
                          </label>

                          {githubReposError && <div className="error-banner">{githubReposError}</div>}
                          {githubReposRateLimited && (
                            <div className="warning-banner">
                              GitHub's rate limit was reached. Try refreshing again shortly.
                            </div>
                          )}

                          {githubReposLoading ? (
                            <div className="empty-state">Loading repositories...</div>
                          ) : githubReposAll.length === 0 ? (
                            !githubReposError && (
                              <div className="empty-state">No accessible repositories were found.</div>
                            )
                          ) : githubRepos.length === 0 ? (
                            <div className="empty-state">No repositories match this search.</div>
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

                          {githubReposLoadingMore && (
                            <p className="text-faint">Loading more repositories...</p>
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
                            <small>Changing this clears any previous inspection result.</small>
                          </label>

                          <div className="form-actions form-actions-start">
                            <button
                              className="secondary-button"
                              type="button"
                              disabled={githubInspecting || !githubBranch}
                              onClick={() => void runGithubInspect()}
                            >
                              {githubInspecting
                                ? "Inspecting..."
                                : githubInspection
                                  ? "Re-inspect Repository"
                                  : "Inspect Repository"}
                            </button>
                          </div>

                          {githubInspectError && <div className="error-banner">{githubInspectError}</div>}

                          {githubInspection && (
                            <>
                              <dl className="wizard-review-grid">
                                <div>
                                  <dt>Detected type</dt>
                                  <dd>
                                    {PROJECT_TYPE_LABELS[githubInspection.detectedProjectType] ??
                                      githubInspection.detectedProjectType}
                                  </dd>
                                </div>
                              </dl>
                              <div className="wizard-row inspection-card">
                                <dl className="wizard-review-grid">
                                  <div>
                                    <dt>Suggested container port</dt>
                                    <dd>{githubInspection.portDetection.detectedPort ?? "None detected"}</dd>
                                  </div>
                                  <div>
                                    <dt>Detected from</dt>
                                    <dd>
                                      {PORT_SOURCE_LABELS[githubInspection.portDetection.source] ??
                                        githubInspection.portDetection.source}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Confidence</dt>
                                    <dd style={{ textTransform: "capitalize" }}>
                                      {githubInspection.portDetection.confidence}
                                    </dd>
                                  </div>
                                </dl>
                                {githubInspection.portDetection.evidence.length > 0 && (
                                  <ul className="wizard-file-list">
                                    {githubInspection.portDetection.evidence.map((item) => (
                                      <li key={item}>{item}</li>
                                    ))}
                                  </ul>
                                )}
                                {githubInspection.portDetection.warnings.length > 0 && (
                                  <ul className="wizard-warning-list">
                                    {githubInspection.portDetection.warnings.map((warning) => (
                                      <li key={warning}>{warning}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </>
                          )}

                          {githubInspection && !githubInspection.supported && githubInspection.unsupportedReason && (
                            <div className="warning-banner">{githubInspection.unsupportedReason}</div>
                          )}

                          {githubInspection && githubInspection.supported && (
                            <>
                              <p className="section-description">
                                Inspection's recommendation is a starting point, not a requirement —
                                choose any supported deployment strategy below.
                              </p>
                              <div className="wizard-row-list">
                                {(Object.keys(STRATEGY_INFO) as Array<Exclude<BuildStrategy, "unsupported">>).map(
                                  (key) => {
                                    const isSelected = githubSelectedStrategy === key;
                                    const isRecommended = githubInspection.recommendedStrategy === key;
                                    return (
                                      <button
                                        key={key}
                                        type="button"
                                        className={`wizard-row strategy-card ${isSelected ? "selected" : ""}`}
                                        onClick={() => chooseGithubStrategy(key)}
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
                                        {!isRecommended && (
                                          <span className="text-faint">Not detected for this repository.</span>
                                        )}
                                      </button>
                                    );
                                  }
                                )}
                              </div>

                              {githubSelectedStrategy === "dockerfile" && (
                                <>
                                  <label>
                                    <span>Dockerfile path</span>
                                    <input
                                      value={githubDockerfilePath}
                                      onChange={(event) => setGithubDockerfilePath(event.target.value)}
                                      placeholder="Dockerfile"
                                    />
                                    <small>Relative to the subdirectory above.</small>
                                  </label>
                                  <label>
                                    <span>Build context</span>
                                    <input
                                      value={githubBuildContext}
                                      onChange={(event) => setGithubBuildContext(event.target.value)}
                                      placeholder="."
                                    />
                                    <small>"." means the subdirectory itself.</small>
                                  </label>
                                </>
                              )}
                            </>
                          )}

                          {githubNodejsStartScriptMissing && (
                            <div className="warning-banner">
                              No "start" script was found in package.json. Add one to the repository
                              before this application can be deployed as a Node.js build.
                            </div>
                          )}

                          {githubInspection && githubInspection.warnings.length > 0 && (
                            <ul className="wizard-warning-list">
                              {githubInspection.warnings.map((warning) => (
                                <li key={warning}>{warning}</li>
                              ))}
                            </ul>
                          )}

                          {!githubInspection && !githubInspecting && !githubInspectError && (
                            <p className="section-description">
                              Inspect this repository before continuing — the platform needs to
                              know what kind of project it is before it can deploy it.
                            </p>
                          )}

                          <label className="checkbox-field">
                            <input
                              type="checkbox"
                              checked={deployAfterCreate}
                              onChange={(event) => setDeployAfterCreate(event.target.checked)}
                            />
                            <span>Deploy immediately after creation (uncheck to save the app and deploy later)</span>
                          </label>

                          <p className="section-description">
                            Continuing will create the app with a temporary internal placeholder —
                            it is never what gets served publicly. The real image is built from this
                            repository and swapped in by the first GitHub deployment, either right
                            after creation or later from the Source tab.
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
                      onChange={(event) => setName(sanitizeAppName(event.target.value))}
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
                      onChange={(event) => {
                        setContainerPort(event.target.value);
                        setContainerPortSource("manual");
                        setContainerPortConfidence(null);
                        setContainerPortManuallySet(true);
                      }}
                      min="1"
                      max="65535"
                      placeholder="3000"
                    />
                    <small>
                      The port the application listens on inside its container.
                    </small>
                  </label>

                  <div className="form-actions form-actions-start">
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={() => void generatePort()}
                      disabled={generatingPort}
                    >
                      {generatingPort ? "Finding a port…" : "Generate available port"}
                    </button>
                  </div>

                  <label>
                    <span>Memory limit (MB)</span>
                    <input
                      type="number"
                      value={memoryLimit}
                      onChange={(event) => setMemoryLimit(event.target.value)}
                      placeholder="No limit"
                      min="16"
                      max="131072"
                    />
                    <small>Optional hard cap. Leave blank for no limit.</small>
                  </label>

                  <label>
                    <span>CPU limit (cores)</span>
                    <input
                      type="number"
                      value={cpuLimit}
                      onChange={(event) => setCpuLimit(event.target.value)}
                      placeholder="No limit"
                      min="0.1"
                      max="64"
                      step="0.1"
                    />
                    <small>Optional. Fractions allowed (e.g. 0.5 = half a core).</small>
                  </label>

                  {sourceType === "github" && containerPort.trim() && (
                    <p className="section-description">
                      {containerPortSource === "manual" || !containerPortSource
                        ? "Manually entered."
                        : `Detected from ${PORT_SOURCE_LABELS[containerPortSource] ?? containerPortSource}${
                            containerPortConfidence ? ` (${containerPortConfidence} confidence)` : ""
                          }.`}
                      {containerPortConfidence === "low" && " Suggested port, not confirmed — verify before deploying."}
                    </p>
                  )}

                  {sourceType === "github" &&
                    githubInspection &&
                    githubInspection.portDetection.detectedPort === null &&
                    githubInspection.portDetection.warnings.length > 0 && (
                      <div className="warning-banner">{githubInspection.portDetection.warnings.join(" ")}</div>
                    )}

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
                      <div className="env-scope-heading-actions">
                        <button
                          className="secondary-button compact"
                          type="button"
                          onClick={() => setShowBulkEnv(true)}
                        >
                          Bulk add
                        </button>
                        <button
                          className="secondary-button compact"
                          type="button"
                          onClick={addEnvRow}
                        >
                          Add Variable
                        </button>
                      </div>
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
                                {row.value.includes("{{companion:") && (
                                  <small className="text-faint">
                                    Becomes{" "}
                                    <code>
                                      {resolveTemplatePlaceholders(
                                        row.value,
                                        trimmedName || "your-app",
                                        templateCompanions
                                      )}
                                    </code>{" "}
                                    — it follows the app name you chose.
                                  </small>
                                )}
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

                  <div className="env-scope-heading published-ports-heading">
                    <h3>Published Ports</h3>
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={addPortRow}
                    >
                      Add Published Port
                    </button>
                  </div>
                  <p className="section-description">
                    Open a raw TCP/UDP port on the server for non-HTTP services
                    (game servers, etc.). Most web apps don't need this — they're
                    already reachable over HTTPS. The host port must also be
                    allowed by the server's firewall.
                  </p>

                  {portRows.length === 0 ? (
                    <div className="empty-state">
                      No published ports. This app is reachable only over the
                      platform's HTTP routing and the private network.
                    </div>
                  ) : (
                    <div className="wizard-row-list">
                      {portRows.map((row) => (
                        <div className="wizard-row" key={row.rowId}>
                          <div className="wizard-row-fields">
                            <label>
                              <span>Host port</span>
                              <input
                                inputMode="numeric"
                                value={row.hostPort}
                                onChange={(event) =>
                                  updatePortRow(row.rowId, {
                                    hostPort: event.target.value
                                  })
                                }
                                placeholder="25565"
                              />
                            </label>
                            <label>
                              <span>Container port</span>
                              <input
                                inputMode="numeric"
                                value={row.containerPort}
                                onChange={(event) =>
                                  updatePortRow(row.rowId, {
                                    containerPort: event.target.value
                                  })
                                }
                                placeholder="25565"
                              />
                            </label>
                            <label>
                              <span>Protocol</span>
                              <select
                                value={row.protocol}
                                onChange={(event) =>
                                  updatePortRow(row.rowId, {
                                    protocol: event.target.value as PortProtocol
                                  })
                                }
                              >
                                <option value="tcp">TCP</option>
                                <option value="udp">UDP</option>
                              </select>
                            </label>
                          </div>

                          <div className="wizard-row-actions">
                            <button
                              className="danger-button compact"
                              type="button"
                              onClick={() => removePortRow(row.rowId)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {portsValidationError && (
                    <div className="error-banner">{portsValidationError}</div>
                  )}
                </div>
              )}

              {step === 5 && (
                <div className="wizard-form-grid">
                  <fieldset className="wizard-fieldset">
                    <legend>Routing</legend>

                    <label className="radio-field">
                      <input
                        type="radio"
                        name="routing-choice"
                        checked={routingChoice === "public"}
                        onChange={() => setRoutingChoice("public")}
                      />
                      <span>
                        <strong>Public app</strong> — reachable at a domain over
                        HTTPS.
                      </span>
                    </label>
                    <label className="radio-field">
                      <input
                        type="radio"
                        name="routing-choice"
                        checked={routingChoice === "internal"}
                        onChange={() => setRoutingChoice("internal")}
                      />
                      <span>
                        <strong>Internal-only app</strong> — no public domain, no
                        route, no TLS certificate. Reachable only from other apps
                        on the platform's private network, by container name.
                      </span>
                    </label>
                  </fieldset>

                  {routingChoice === "public" && (
                    <fieldset className="wizard-fieldset">
                      <legend>Domain</legend>

                      <label className="radio-field">
                        <input
                          type="radio"
                          name="domain-choice"
                          checked={domainChoice === "default"}
                          onChange={() => setDomainChoice("default")}
                        />
                        <span>Use the platform's generated domain</span>
                      </label>
                      <label className="radio-field">
                        <input
                          type="radio"
                          name="domain-choice"
                          checked={domainChoice === "custom"}
                          onChange={() => setDomainChoice("custom")}
                        />
                        <span>Use a custom domain</span>
                      </label>

                      {domainChoice === "custom" && (
                        <label>
                          <span>Custom domain</span>
                          <input
                            type="text"
                            value={customDomain}
                            onChange={(event) => setCustomDomain(event.target.value)}
                            placeholder="roadmapstudio.xyz"
                            spellCheck={false}
                            autoCapitalize="off"
                          />
                          {trimmedCustomDomain.length > 0 &&
                            !isValidCustomDomain(trimmedCustomDomain) && (
                              <small className="text-faint">
                                Enter a plain hostname with no scheme, path,
                                port, or wildcard (e.g. roadmapstudio.xyz).
                              </small>
                            )}
                          <small className="text-faint">
                            DNS for this domain must already point (or be
                            pointed) at this server — the platform does not
                            configure DNS automatically.
                          </small>
                        </label>
                      )}
                    </fieldset>
                  )}

                  <dl className="wizard-review-grid">
                    <div>
                      <dt>{routingChoice === "internal" ? "Public URL" : "Public domain"}</dt>
                      <dd>
                        {routingChoice === "internal"
                          ? "Internal only, no public URL"
                          : (domainChoice === "custom" ? trimmedCustomDomain || "—" : domain ?? "Generating...")}
                      </dd>
                    </div>
                    <div>
                      <dt>HTTPS</dt>
                      <dd>
                        {routingChoice === "internal"
                          ? "Not applicable — this app has no public route."
                          : "Automatic — the platform manages TLS certificates."}
                      </dd>
                    </div>
                    <div>
                      <dt>Routing</dt>
                      <dd>
                        {routingChoice === "internal"
                          ? "No Caddy route is created for this app."
                          : "Configured automatically once the app is created."}
                      </dd>
                    </div>
                    <div>
                      <dt>Docker network</dt>
                      <dd>Managed by the platform — reachable from other apps by container name.</dd>
                    </div>
                  </dl>
                </div>
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
                      <dt>Routing</dt>
                      <dd>
                        {routingChoice === "internal"
                          ? "Internal only, no public URL"
                          : domainChoice === "custom"
                            ? trimmedCustomDomain || "—"
                            : (domain ?? "—")}
                      </dd>
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

                  {templateCompanions.length > 0 && (
                    <div className="env-scope-block">
                      <div className="env-scope-heading">
                        <h3>Services deployed with this app</h3>
                      </div>
                      <p className="section-description">
                        These are created first, as managed apps of their own — each gets its
                        own container, storage, and Delete button, and can be removed
                        separately later.
                      </p>
                      <div className="wizard-row-list">
                        {templateCompanions.map((companion) => (
                          <div className="wizard-row" key={companion.key}>
                            <strong>
                              {companion.label}{" "}
                              <code>app-{companionAppName(trimmedName, companion)}</code>
                            </strong>
                            <span className="text-faint">{companion.description}</span>
                            <span className="text-faint">
                              {companion.image} · port {companion.containerPort} ·{" "}
                              {companion.internalOnly ?? true
                                ? "internal only, no public domain"
                                : "public"}
                              {companion.volumes && companion.volumes.length > 0
                                ? ` · storage: ${companion.volumes.join(", ")}`
                                : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {pendingModel && (
                    <div className="notice-banner">
                      After deployment, <code>{pendingModel}</code> will start downloading in
                      the background. The app stays usable while it downloads, and the
                      download can be retried from the Blueprint tab.
                    </div>
                  )}

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

                  {createError && (
                    <div className="error-banner" role="alert">
                      {createError}
                    </div>
                  )}
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
                      : sourceType === "github"
                        ? deployAfterCreate
                          ? "Create and Deploy"
                          : "Save Without Deploying"
                        : "Create App"}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      <BulkEnvVarDialog
        open={showBulkEnv}
        existingSecrets={existingEnvSecrets}
        submitting={false}
        error=""
        onSubmit={applyBulkEnv}
        onCancel={() => setShowBulkEnv(false)}
      />

      <InstallProgressModal
        open={showInstallProgress}
        appName={trimmedName}
        progress={installProgress}
        error={createError}
        onClose={() => setShowInstallProgress(false)}
      />
    </div>
  );
}
