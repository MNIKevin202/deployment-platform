import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiError,
  AppDetail as AppDetailData,
  ContainerAction,
  EffectiveEnvVar,
  EnvVarFormValues,
  MaskedAppEnvVar,
  MaskedGlobalEnvVar,
  RedeployResponse,
  StorageFormValues,
  StoredAppVolume,
  UpdateAppRoutingPayload,
  UpdateAppRoutingResponse
} from "../types/api";
import StatusBadge from "./StatusBadge";
import ImageUpdateBanner from "./ImageUpdateBanner";
import ConfirmationDialog from "./ConfirmationDialog";
import Tabs from "./Tabs";
import EnvVarTable from "./EnvVarTable";
import EnvVarDialog from "./EnvVarDialog";
import BulkEnvVarDialog from "./BulkEnvVarDialog";
import EnvironmentExportDialog from "./EnvironmentExportDialog";
import MoveVariableDialog, {
  type MoveDirection,
  type MoveDisposition
} from "./MoveVariableDialog";
import DomainDialog from "./DomainDialog";
import StorageTable from "./StorageTable";
import StorageDialog from "./StorageDialog";
import HealthPanel from "./HealthPanel";
import PerformanceDiagnosticsPanel from "./PerformanceDiagnosticsPanel";
import BuildLogPanel from "./BuildLogPanel";
import ActivityPanel from "./ActivityPanel";
import ConsolePanel from "./ConsolePanel";
import ResourcesSection from "./ResourcesSection";
import HistoryPanel from "./HistoryPanel";
import SourcePanel from "./SourcePanel";
import IrcSettingsPanel from "./IrcSettingsPanel";
import IrcBotSettingsPanel from "./IrcBotSettingsPanel";
import { isIrcServerImage, isIrcBotImage, isBlueprintImage } from "../lib/appKind";
import BlueprintPanel from "./BlueprintPanel";
import { useAppDeployProgress } from "../lib/deployProgress";
import { DeployProgressBanner } from "./DeployProgressIndicator";

// Pulls in recharts (a large dependency) only when the Metrics tab is
// actually opened, instead of shipping it in every page's initial bundle.
const MetricsPanel = lazy(() => import("./MetricsPanel"));

interface AppDetailProps {
  appId: number;
  onBack: () => void;
  onDeleted: () => void;
  onAppChanged: () => void;
  onGoToGlobalEnvironment: () => void;
}

type DetailTab =
  | "overview"
  | "source"
  | "environment"
  | "storage"
  | "networking"
  | "resources"
  | "health"
  | "metrics"
  | "performance"
  | "logs"
  | "console"
  | "history"
  | "activity"
  | "irc-settings"
  | "bot-settings"
  | "blueprint";

type GroupKey =
  | "overview"
  | "deployments"
  | "configuration"
  | "monitoring"
  | "logs"
  | "activity"
  | "irc-settings"
  | "bot-settings"
  | "blueprint";

interface TabGroup {
  key: GroupKey;
  label: string;
  members: DetailTab[];
}

/** Sub-tab label for each granular member. */
const MEMBER_LABELS: Record<DetailTab, string> = {
  overview: "Overview",
  source: "Source",
  history: "Versions",
  environment: "Environment",
  storage: "Storage",
  networking: "Networking",
  resources: "Resource limits",
  health: "Health",
  metrics: "Metrics",
  performance: "Performance",
  console: "Runtime",
  logs: "Build",
  activity: "Activity",
  "irc-settings": "Settings",
  "bot-settings": "Settings",
  blueprint: "Blueprint"
};

/**
 * The App Detail "command center": six primary groups collapse the former
 * eleven tabs. Each group keeps its members as granular render targets (so the
 * existing panels, their lazy loads, and the env/storage fetch gates are
 * untouched); a group with more than one member shows a secondary sub-tab bar.
 * Image-specific panels (IRC, Blueprint) append as their own single groups.
 */
function buildTabGroups(image: string): TabGroup[] {
  const groups: TabGroup[] = [
    { key: "overview", label: "Overview", members: ["overview"] },
    { key: "deployments", label: "Deployments", members: ["source", "history"] },
    {
      key: "configuration",
      label: "Configuration",
      members: ["environment", "storage", "networking", "resources"]
    },
    { key: "monitoring", label: "Monitoring", members: ["health", "metrics", "performance"] },
    // Runtime (live console) first, then the last Build log — one home for "logs".
    { key: "logs", label: "Logs", members: ["console", "logs"] },
    { key: "activity", label: "Activity", members: ["activity"] }
  ];

  if (isIrcServerImage(image)) {
    groups.push({ key: "irc-settings", label: "Settings", members: ["irc-settings"] });
  }
  if (isIrcBotImage(image)) {
    groups.push({ key: "bot-settings", label: "Settings", members: ["bot-settings"] });
  }
  if (isBlueprintImage(image)) {
    groups.push({ key: "blueprint", label: "Blueprint", members: ["blueprint"] });
  }

  return groups;
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

const DELETE_TIMEOUT_MS = 20_000;
const DELETE_RETRY_DELAY_MS = 1_500;

/**
 * Deletes a container with a bounded, idempotency-key-safe timeout + retry.
 *
 * Two failure modes both need to be caught, not just one: a network-level
 * fetch() rejection (a definitive "no response arrived"), AND a connection
 * that is silently dropped without ever rejecting or resolving — which is
 * what a Caddy container restart severing this very request's connection can
 * look like from the browser's side. An AbortController-driven timeout turns
 * the second case into the same, catchable shape as the first, so a hung
 * request cannot freeze the confirmation dialog forever.
 *
 * On either failure, exactly one retry is sent with the SAME Idempotency-Key
 * and the SAME target. If the original request actually reached and was
 * processed by the server before the connection was lost, the API recognizes
 * the repeated key and replays that result — so the retry safely resolves to
 * success instead of re-deleting (impossible — it's already gone) or
 * reporting a misleading error for a deletion that already succeeded.
 */
async function deleteAppWithRetry(
  containerId: string,
  idempotencyKey: string
): Promise<Response> {
  const attempt = () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), DELETE_TIMEOUT_MS);
    return fetch(`/api/apps/${containerId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey },
      signal: controller.signal
    }).finally(() => window.clearTimeout(timer));
  };

  try {
    return await attempt();
  } catch {
    await new Promise((resolve) => window.setTimeout(resolve, DELETE_RETRY_DELAY_MS));
    return attempt();
  }
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Never";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null) {
    return "Unknown";
  }

  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

export default function AppDetail({
  appId,
  onBack,
  onDeleted,
  onAppChanged,
  onGoToGlobalEnvironment
}: AppDetailProps) {
  const [detail, setDetail] = useState<AppDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionLoading, setActionLoading] = useState<
    ContainerAction | "delete" | "redeploy" | null
  >(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // A ref, not the `actionLoading` state, is what actually prevents a second
  // delete request — see submitLockRef in CreateAppWizard for why a state
  // read is racy across a fast double-confirm and a ref mutation is not.
  const deleteLockRef = useRef(false);
  const [showRedeployConfirm, setShowRedeployConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");

  const [appVars, setAppVars] = useState<MaskedAppEnvVar[]>([]);
  const [globalVars, setGlobalVars] = useState<MaskedGlobalEnvVar[]>([]);
  const [effectiveVars, setEffectiveVars] = useState<EffectiveEnvVar[]>([]);
  const [envLoaded, setEnvLoaded] = useState(false);
  const [envLoading, setEnvLoading] = useState(false);
  const [envError, setEnvError] = useState("");

  const [showEnvDialog, setShowEnvDialog] = useState(false);
  const [editingVar, setEditingVar] = useState<MaskedAppEnvVar | null>(null);
  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ direction: MoveDirection; key: string } | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState("");
  const [envSubmitting, setEnvSubmitting] = useState(false);
  const [envDialogError, setEnvDialogError] = useState("");
  const [envDeleteTarget, setEnvDeleteTarget] = useState<MaskedAppEnvVar | null>(
    null
  );
  const [envDeleting, setEnvDeleting] = useState(false);

  const [showBulkEnvDialog, setShowBulkEnvDialog] = useState(false);
  const [bulkEnvSubmitting, setBulkEnvSubmitting] = useState(false);
  const [bulkEnvError, setBulkEnvError] = useState("");
  const [showEnvExportDialog, setShowEnvExportDialog] = useState(false);
  const [envExporting, setEnvExporting] = useState(false);
  const [envExportError, setEnvExportError] = useState("");

  const copyEffectiveEnvironment = async (password: string) => {
    try {
      setEnvExporting(true);
      setEnvExportError("");
      const response = await fetch(`/api/apps/${appId}/environment/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!response.ok) throw new Error(await readApiError(response, "Unable to copy variables"));
      const result = (await response.json()) as { content: string };
      await navigator.clipboard.writeText(result.content);
      setShowEnvExportDialog(false);
      setNotice("The effective environment was copied, including secret values.");
    } catch (error) {
      setEnvExportError(error instanceof Error ? error.message : "Unable to copy variables");
    } finally {
      setEnvExporting(false);
    }
  };

  const [showDomainDialog, setShowDomainDialog] = useState(false);
  const [domainSubmitting, setDomainSubmitting] = useState(false);
  const [domainError, setDomainError] = useState("");

  const [storageVolumes, setStorageVolumes] = useState<StoredAppVolume[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState("");

  const [showStorageDialog, setShowStorageDialog] = useState(false);
  const [editingVolume, setEditingVolume] = useState<StoredAppVolume | null>(
    null
  );
  const [storageSubmitting, setStorageSubmitting] = useState(false);
  const [storageDialogError, setStorageDialogError] = useState("");
  const [storageDeleteTarget, setStorageDeleteTarget] =
    useState<StoredAppVolume | null>(null);
  const [storageDeleting, setStorageDeleting] = useState(false);

  // Live deploy progress for this app (from the shared SSE stream). Present
  // only while a deployment is in flight — the banner appears on Redeploy and
  // disappears the moment it finishes.
  const deployProgress = useAppDeployProgress(appId);

  const loadDetail = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError("");
      setNotFound(false);

      const response = await fetch(`/api/apps/${appId}`);

      if (response.status === 404) {
        setNotFound(true);
        return;
      }

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to load app details")
        );
      }

      const result = (await response.json()) as AppDetailData;
      setDetail(result);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to load app details"
      );
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const loadEnvironment = useCallback(async () => {
    try {
      setEnvLoading(true);
      setEnvError("");

      const [appVarsResponse, globalVarsResponse, effectiveResponse] =
        await Promise.all([
          fetch(`/api/apps/${appId}/environment`),
          fetch("/api/environment/global"),
          fetch(`/api/apps/${appId}/environment/effective`)
        ]);

      if (!appVarsResponse.ok || !globalVarsResponse.ok || !effectiveResponse.ok) {
        throw new Error("Unable to load environment variables");
      }

      const appVarsResult = (await appVarsResponse.json()) as {
        variables: MaskedAppEnvVar[];
      };
      const globalVarsResult = (await globalVarsResponse.json()) as {
        variables: MaskedGlobalEnvVar[];
      };
      const effectiveResult = (await effectiveResponse.json()) as {
        variables: EffectiveEnvVar[];
      };

      setAppVars(appVarsResult.variables);
      setGlobalVars(globalVarsResult.variables);
      setEffectiveVars(effectiveResult.variables);
      setEnvLoaded(true);
    } catch (error) {
      setEnvError(
        error instanceof Error
          ? error.message
          : "Unable to load environment variables"
      );
    } finally {
      setEnvLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    if (activeTab === "environment" && !envLoaded) {
      void loadEnvironment();
    }
  }, [activeTab, envLoaded, loadEnvironment]);

  const loadStorage = useCallback(async () => {
    try {
      setStorageLoading(true);
      setStorageError("");

      const response = await fetch(`/api/apps/${appId}/storage`);

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to load storage mounts")
        );
      }

      const result = (await response.json()) as {
        volumes: StoredAppVolume[];
      };

      setStorageVolumes(result.volumes);
      setStorageLoaded(true);
    } catch (error) {
      setStorageError(
        error instanceof Error
          ? error.message
          : "Unable to load storage mounts"
      );
    } finally {
      setStorageLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    if ((activeTab === "storage" || showDeleteConfirm) && !storageLoaded) {
      void loadStorage();
    }
    // Also loaded when the delete dialog opens (not just the Storage tab) so
    // the internal-only + persistent-volumes delete warning below can know
    // whether this app has any volumes without requiring the operator to
    // have visited the Storage tab first.
  }, [activeTab, showDeleteConfirm, storageLoaded, loadStorage]);

  const runAction = async (action: ContainerAction) => {
    if (!detail?.containerId || actionLoading) {
      return;
    }

    try {
      setActionError("");
      setNotice("");
      setActionLoading(action);

      const response = await fetch(
        `/api/containers/${detail.containerId}/${action}`,
        { method: "POST" }
      );

      if (!response.ok) {
        throw new Error(
          await readApiError(response, `Unable to ${action} app`)
        );
      }

      setNotice(`App ${action} completed.`);
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : `Unable to ${action} app`
      );
    } finally {
      setActionLoading(null);
    }
  };

  const confirmDelete = async () => {
    if (!detail || deleteLockRef.current) {
      return;
    }
    deleteLockRef.current = true;

    try {
      setActionError("");
      setActionLoading("delete");

      // When the container is missing there is no live container id to
      // target, so delete by app id (tolerating an already-gone runtime).
      // Otherwise use the idempotency-key-safe container-id path.
      const response = detail.containerExists && detail.containerId
        ? await deleteAppWithRetry(detail.containerId, crypto.randomUUID())
        : await fetch(`/api/apps/by-app-id/${appId}`, { method: "DELETE" });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to delete app"));
      }

      setShowDeleteConfirm(false);
      onAppChanged();
      onDeleted();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to delete app"
      );
      setActionLoading(null);
    } finally {
      deleteLockRef.current = false;
    }
  };

  const confirmRedeploy = async () => {
    if (actionLoading) {
      return;
    }

    try {
      setActionError("");
      setNotice("");
      setActionLoading("redeploy");

      const response = await fetch(`/api/apps/${appId}/redeploy`, {
        method: "POST"
      });

      const result = (await response
        .json()
        .catch(() => ({}))) as Partial<RedeployResponse>;

      if (!response.ok) {
        throw new Error(result.message || "Unable to redeploy app");
      }

      setShowRedeployConfirm(false);
      setNotice(result.message || "App redeployed successfully.");
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to redeploy app"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const openCreateEnvDialog = () => {
    setEditingVar(null);
    setOverrideKey(null);
    setEnvDialogError("");
    setShowEnvDialog(true);
  };

  const openOverrideDialog = (globalVar: EffectiveEnvVar) => {
    setEditingVar(null);
    setOverrideKey(globalVar.key);
    setEnvDialogError("");
    setShowEnvDialog(true);
  };

  const openEditEnvDialog = (variable: MaskedAppEnvVar) => {
    setEditingVar(variable);
    setOverrideKey(null);
    setEnvDialogError("");
    setShowEnvDialog(true);
  };

  const openMoveDialog = (direction: MoveDirection, key: string) => {
    setMoveError("");
    setMoveTarget({ direction, key });
  };

  const runMove = async (disposition: MoveDisposition) => {
    if (!moveTarget) {
      return;
    }

    try {
      setMoving(true);
      setMoveError("");

      const response = await fetch(`/api/apps/${appId}/environment/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...moveTarget, disposition })
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to move the variable"));
      }

      const movedTo = moveTarget.direction === "global-to-app" ? "this app" : "the global scope";
      setNotice(`${moveTarget.key} was moved to ${movedTo}.`);
      setMoveTarget(null);
      await loadEnvironment();
      void loadDetail();
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : "Unable to move the variable");
    } finally {
      setMoving(false);
    }
  };

  const submitEnvDialog = async (values: EnvVarFormValues) => {
    try {
      setEnvSubmitting(true);
      setEnvDialogError("");

      if (editingVar) {
        const body: Partial<EnvVarFormValues> = {
          isSecret: values.isSecret,
          enabled: values.enabled
        };

        if (!(editingVar.isSecret && values.value === "")) {
          body.value = values.value;
        }

        const response = await fetch(
          `/api/apps/${appId}/environment/${editingVar.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          }
        );

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Unable to update variable")
          );
        }

        setNotice(`${editingVar.key} was updated.`);
      } else {
        const response = await fetch(`/api/apps/${appId}/environment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values)
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Unable to create variable")
          );
        }

        setNotice(`${values.key} was added.`);
      }

      setShowEnvDialog(false);
      await loadEnvironment();
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setEnvDialogError(
        error instanceof Error ? error.message : "Unable to save variable"
      );
    } finally {
      setEnvSubmitting(false);
    }
  };

  const submitBulkEnvDialog = async (
    variables: { key: string; value: string; isSecret: boolean }[]
  ) => {
    try {
      setBulkEnvSubmitting(true);
      setBulkEnvError("");

      const response = await fetch(`/api/apps/${appId}/environment/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variables })
      });

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to apply variables")
        );
      }

      const result = (await response.json()) as {
        created: number;
        updated: number;
      };

      const parts: string[] = [];
      if (result.created > 0) parts.push(`${result.created} added`);
      if (result.updated > 0) parts.push(`${result.updated} updated`);
      setNotice(
        parts.length > 0
          ? `Applied variables — ${parts.join(", ")}.`
          : "No changes were applied."
      );

      setShowBulkEnvDialog(false);
      await loadEnvironment();
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setBulkEnvError(
        error instanceof Error ? error.message : "Unable to apply variables"
      );
    } finally {
      setBulkEnvSubmitting(false);
    }
  };

  const submitDomainDialog = async (payload: UpdateAppRoutingPayload) => {
    try {
      setDomainSubmitting(true);
      setDomainError("");

      const response = await fetch(`/api/apps/${appId}/routing`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to update routing")
        );
      }

      const result = (await response.json()) as UpdateAppRoutingResponse;

      setNotice(
        result.internalOnly
          ? "This app is now internal-only — its public domain was removed."
          : `Domain updated — now reachable at ${result.domain ?? "the assigned domain"}.`
      );

      setShowDomainDialog(false);
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setDomainError(
        error instanceof Error ? error.message : "Unable to update routing"
      );
    } finally {
      setDomainSubmitting(false);
    }
  };

  const confirmEnvDelete = async () => {
    if (!envDeleteTarget) {
      return;
    }

    try {
      setEnvDeleting(true);

      const response = await fetch(
        `/api/apps/${appId}/environment/${envDeleteTarget.id}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to delete variable")
        );
      }

      setNotice(`${envDeleteTarget.key} was deleted.`);
      setEnvDeleteTarget(null);
      await loadEnvironment();
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setEnvError(
        error instanceof Error ? error.message : "Unable to delete variable"
      );
      setEnvDeleteTarget(null);
    } finally {
      setEnvDeleting(false);
    }
  };

  const openCreateStorageDialog = () => {
    setEditingVolume(null);
    setStorageDialogError("");
    setShowStorageDialog(true);
  };

  const openEditStorageDialog = (volume: StoredAppVolume) => {
    setEditingVolume(volume);
    setStorageDialogError("");
    setShowStorageDialog(true);
  };

  const submitStorageDialog = async (values: StorageFormValues) => {
    try {
      setStorageSubmitting(true);
      setStorageDialogError("");

      if (editingVolume) {
        const response = await fetch(
          `/api/apps/${appId}/storage/${editingVolume.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              containerPath: values.containerPath,
              readOnly: values.readOnly
            })
          }
        );

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Unable to update storage mount")
          );
        }

        setNotice(`${values.containerPath} was updated.`);
      } else {
        const response = await fetch(`/api/apps/${appId}/storage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            containerPath: values.containerPath,
            volumeName: values.volumeName || undefined,
            readOnly: values.readOnly
          })
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Unable to add storage mount")
          );
        }

        setNotice(`Storage mount at ${values.containerPath} was added.`);
      }

      setShowStorageDialog(false);
      await loadStorage();
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setStorageDialogError(
        error instanceof Error ? error.message : "Unable to save storage mount"
      );
    } finally {
      setStorageSubmitting(false);
    }
  };

  const confirmStorageDelete = async () => {
    if (!storageDeleteTarget) {
      return;
    }

    try {
      setStorageDeleting(true);

      const response = await fetch(
        `/api/apps/${appId}/storage/${storageDeleteTarget.id}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to remove storage mount")
        );
      }

      setNotice(
        `The storage mount at ${storageDeleteTarget.containerPath} was removed. Its Docker volume was not deleted.`
      );
      setStorageDeleteTarget(null);
      await loadStorage();
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setStorageError(
        error instanceof Error
          ? error.message
          : "Unable to remove storage mount"
      );
      setStorageDeleteTarget(null);
    } finally {
      setStorageDeleting(false);
    }
  };

  if (loading && !detail) {
    return (
      <section className="app-detail">
        <button className="secondary-button" type="button" onClick={onBack}>
          Back
        </button>
        <p className="empty-state">Loading app details...</p>
      </section>
    );
  }

  if (notFound) {
    return (
      <section className="app-detail">
        <button className="secondary-button" type="button" onClick={onBack}>
          Back
        </button>
        <div className="empty-state">
          <h3>App not found</h3>
          <p>This app may have already been deleted.</p>
        </div>
      </section>
    );
  }

  if (loadError || !detail) {
    return (
      <section className="app-detail">
        <button className="secondary-button" type="button" onClick={onBack}>
          Back
        </button>
        <div className="error-banner">
          {loadError || "Unable to load app details"}
        </div>
      </section>
    );
  }

  const isRunning = detail.dockerState === "running";
  const canOpenApp = Boolean(detail.domain) && detail.routingReady;
  // Reflects environment AND storage changes — Docker can't apply either
  // kind to a running container, so both are "pending" until redeploy.
  const isConfigPending = detail.environmentStatus === "pending";
  const inheritedGlobals = effectiveVars.filter((v) => v.source === "global");

  const tabGroups = buildTabGroups(detail.image);
  const activeGroup =
    tabGroups.find((group) => group.members.includes(activeTab)) ?? tabGroups[0];

  return (
    <section className="app-detail">
      <div className="app-detail-header">
        <button className="secondary-button" type="button" onClick={onBack}>
          Back
        </button>

        <div className="app-detail-title-row">
          <h1>{detail.name}</h1>
          <StatusBadge
            label={detail.containerExists ? detail.dockerState ?? "unknown" : "missing"}
            tone={
              !detail.containerExists
                ? "negative"
                : isRunning
                  ? "positive"
                  : "neutral"
            }
          />
          <StatusBadge
            label={
              detail.internalOnly
                ? "Internal only"
                : canOpenApp
                  ? "Routing ready"
                  : "Routing not ready"
            }
            tone={detail.internalOnly ? "neutral" : canOpenApp ? "positive" : "warning"}
          />
          <StatusBadge
            label={isConfigPending ? "Changes Pending" : "Config Applied"}
            tone={isConfigPending ? "warning" : "positive"}
          />
        </div>

        {deployProgress && <DeployProgressBanner progress={deployProgress} />}

        <ImageUpdateBanner
          appId={appId}
          imageUpdateAvailable={detail.imageUpdateAvailable}
          imageUpdateCheckedAt={detail.imageUpdateCheckedAt}
        />

        {/* Live runtime console, front and centre on the Overview. Hidden on
            the Logs tab (which streams its own), so only one stream is open. */}
        {detail.containerExists && activeTab === "overview" && (
          <ConsolePanel
            appId={appId}
            compact
            onOpenFull={() => setActiveTab("console")}
          />
        )}

        <div className="container-actions app-detail-actions">
          {canOpenApp && (
            <a
              className="secondary-button open-app-button"
              href={`https://${detail.domain}`}
              target="_blank"
              rel="noreferrer"
            >
              Open App
            </a>
          )}

          <button
            className={isConfigPending ? "primary-button" : "secondary-button"}
            type="button"
            onClick={() => setShowRedeployConfirm(true)}
            disabled={actionLoading !== null}
          >
            {actionLoading === "redeploy" ? "Redeploying..." : "Redeploy"}
          </button>

          {detail.containerExists && (
            <button
              type="button"
              onClick={() => void runAction("restart")}
              disabled={!isRunning || actionLoading !== null}
            >
              {actionLoading === "restart" ? "Restarting..." : "Restart"}
            </button>
          )}

          {detail.containerExists && !isRunning && (
            <button
              type="button"
              onClick={() => void runAction("start")}
              disabled={actionLoading !== null}
            >
              {actionLoading === "start" ? "Starting..." : "Start"}
            </button>
          )}

          {detail.containerExists && isRunning && (
            <button
              type="button"
              onClick={() => void runAction("stop")}
              disabled={actionLoading !== null}
            >
              {actionLoading === "stop" ? "Stopping..." : "Stop"}
            </button>
          )}

          <button
            className="danger-button"
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={actionLoading !== null}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Suppressed while the delete dialog is open: it renders actionError
          itself now (see the ConfirmationDialog usage below) — this modal
          covers the whole page, so showing the same error here too was
          invisible, redundant duplication, not a second, useful location. */}
      {actionError && !showDeleteConfirm && (
        <div className="error-banner">{actionError}</div>
      )}
      {notice && <div className="notice-banner">{notice}</div>}

      {!detail.containerExists && (
        <div className="error-banner">
          The Docker container for this app is missing. Start, Stop,
          Restart, and Logs are unavailable until it exists again — use
          Redeploy below to recreate it.
        </div>
      )}

      <Tabs
        items={tabGroups.map((group) => ({ key: group.key, label: group.label }))}
        active={activeGroup.key}
        onChange={(key) => {
          const group = tabGroups.find((candidate) => candidate.key === key);
          if (group && !group.members.includes(activeTab)) {
            setActiveTab(group.members[0]);
          }
        }}
      />

      {activeGroup.members.length > 1 && (
        <div className="app-detail-subtabs">
          <Tabs
            items={activeGroup.members.map((member) => ({
              key: member,
              label: MEMBER_LABELS[member]
            }))}
            active={activeTab}
            onChange={(key) => setActiveTab(key as DetailTab)}
          />
        </div>
      )}

      {activeTab === "overview" && (
        <div className="app-detail-tab-panel">
          <div className="cc-signals">
            <div className="cc-card">
              <div className="cc-card-h">Deployment</div>
              <div className="cc-card-lead">
                {detail.lastDeploymentStatus === "failed" ? (
                  <span className="status-badge danger compact">Deploy failed</span>
                ) : detail.lastDeployedAt ? (
                  <span className="status-badge positive compact">Deployed</span>
                ) : (
                  <span className="status-badge neutral compact">Not yet deployed</span>
                )}
              </div>
              <div className="cc-kv"><span>Last deployed</span><span>{formatDate(detail.lastDeployedAt)}</span></div>
              <div className="cc-kv">
                <span>Duration</span>
                <span>
                  {formatDuration(detail.lastDeploymentDurationMs)}
                  {detail.lastDeploymentStatus === "failed" && (
                    <span className="deployment-status-failed"> (failed)</span>
                  )}
                </span>
              </div>
              <button className="cc-link" type="button" onClick={() => setActiveTab("source")}>
                View deployments →
              </button>
            </div>

            <div className="cc-card">
              <div className="cc-card-h">Domain &amp; routing</div>
              <div className="cc-card-lead">
                {detail.internalOnly ? (
                  <span className="routing-badge internal-only">Internal only</span>
                ) : detail.domain ? (
                  <a className="public-domain-link" href={`https://${detail.domain}`} target="_blank" rel="noopener noreferrer">
                    {detail.domain}
                  </a>
                ) : (
                  <span className="text-faint">No domain assigned</span>
                )}
              </div>
              <div className="cc-kv">
                <span>Reach</span>
                <span>{detail.internalOnly ? `app-${detail.name}:${detail.containerPort}` : "Public HTTPS"}</span>
              </div>
              {detail.publishedPorts.length > 0 && (
                <div className="cc-kv">
                  <span>Published</span>
                  <span>{detail.publishedPorts.length} port{detail.publishedPorts.length === 1 ? "" : "s"}</span>
                </div>
              )}
              <button className="cc-link" type="button" onClick={() => setActiveTab("networking")}>
                Configure →
              </button>
            </div>

            <div className="cc-card">
              <div className="cc-card-h">Resources</div>
              <div className="cc-kv"><span>Memory limit</span><span>{detail.memoryLimitMb ? `${detail.memoryLimitMb} MB` : "Unlimited"}</span></div>
              <div className="cc-kv"><span>CPU limit</span><span>{detail.cpuLimit ? `${detail.cpuLimit} cores` : "Shared"}</span></div>
              <div className="cc-kv"><span>Restart</span><span>{detail.restartPolicy}</span></div>
              <button className="cc-link" type="button" onClick={() => setActiveTab("metrics")}>
                Live metrics →
              </button>
            </div>

            <div className="cc-card">
              <div className="cc-card-h">Runtime</div>
              <div className="cc-kv"><span>Docker</span><span>{detail.dockerStatusText ?? "Unavailable"}</span></div>
              <div className="cc-kv"><span>Image</span><span className="cc-mono">{detail.image}</span></div>
              <div className="cc-kv"><span>Internal port</span><span className="cc-mono">{detail.containerPort}</span></div>
              <button className="cc-link" type="button" onClick={() => setActiveTab("console")}>
                Runtime logs →
              </button>
            </div>
          </div>

          <h3 className="cc-details-h">Details</h3>
          <dl className="app-detail-grid">
            <div>
              <dt>Public domain</dt>
              <dd className="domain-cell">
                {detail.internalOnly ? (
                  <span className="routing-badge internal-only">Internal only</span>
                ) : detail.domain ? (
                  <a className="public-domain-link" href={`https://${detail.domain}`} target="_blank" rel="noopener noreferrer">
                    {detail.domain}
                  </a>
                ) : (
                  "Not assigned"
                )}
              </dd>
            </div>

            <div>
              <dt>Docker image</dt>
              <dd>{detail.image}</dd>
            </div>

            <div>
              <dt>Internal port</dt>
              <dd>{detail.containerPort}</dd>
            </div>

            {detail.publishedPorts.length > 0 && (
              <div>
                <dt>Published ports</dt>
                <dd>
                  {detail.publishedPorts.map((port) => (
                    <div key={`${port.hostPort}/${port.protocol}`} className="published-port-line">
                      <code>
                        {port.hostPort} → {port.containerPort}/{port.protocol}
                      </code>
                    </div>
                  ))}
                  <small className="text-faint">
                    Reachable on the server's public IP at the host port
                    (firewall permitting).
                  </small>
                </dd>
              </div>
            )}

            <div>
              <dt>Container name</dt>
              <dd>{detail.containerName ?? "Unknown"}</dd>
            </div>

            <div>
              <dt>Container ID</dt>
              <dd title={detail.containerId ?? undefined}>
                {detail.shortContainerId ?? "Unknown"}
              </dd>
            </div>

            <div>
              <dt>Docker status</dt>
              <dd>{detail.dockerStatusText ?? "Unavailable"}</dd>
            </div>

            <div>
              <dt>Restart policy</dt>
              <dd>{detail.restartPolicy}</dd>
            </div>

            <div>
              <dt>Desired status</dt>
              <dd>{detail.desiredStatus}</dd>
            </div>

            <div>
              <dt>Created</dt>
              <dd>{formatDate(detail.createdAt)}</dd>
            </div>

            <div>
              <dt>Updated</dt>
              <dd>{formatDate(detail.updatedAt)}</dd>
            </div>

            <div>
              <dt>Last deployed</dt>
              <dd>{formatDate(detail.lastDeployedAt)}</dd>
            </div>

            <div>
              <dt>Deploy duration</dt>
              <dd>
                {formatDuration(detail.lastDeploymentDurationMs)}
                {detail.lastDeploymentStatus === "failed" && (
                  <span className="deployment-status-failed"> (failed)</span>
                )}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {activeTab === "source" && <SourcePanel appId={appId} />}

      {activeTab === "environment" && (
        <div className="app-detail-tab-panel">
          {envError && <div className="error-banner">{envError}</div>}

          <div className="env-scope-block">
            <div className="env-scope-heading">
              <h3>Effective Environment</h3>
              <div className="env-scope-heading-actions">
                <StatusBadge
                  label={isConfigPending ? "Changes Pending" : "Applied"}
                  tone={isConfigPending ? "warning" : "positive"}
                />
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => { setEnvExportError(""); setShowEnvExportDialog(true); }}
                >
                  Copy All
                </button>
              </div>
            </div>
            <p className="section-description">
              {isConfigPending
                ? "Saved, but not active in the running container yet. Restarting will not apply these changes — use Redeploy above (for a GitHub-linked app it rebuilds from source; otherwise it recreates the container), which applies the current variables."
                : "The running container reflects the variables below."}
            </p>
          </div>

          {envLoading && !envLoaded ? (
            <div className="empty-state">Loading environment variables...</div>
          ) : (
            <>
              <div className="env-scope-block">
                <div className="env-scope-heading">
                  <h3>Inherited from Global</h3>
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={onGoToGlobalEnvironment}
                  >
                    Manage Global Variables
                  </button>
                </div>

                {inheritedGlobals.length === 0 ? (
                  <div className="empty-state">
                    No enabled global variables are currently inherited.
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="env-table">
                      <thead>
                        <tr>
                          <th>Key</th>
                          <th>Value</th>
                          <th aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {inheritedGlobals.map((variable) => (
                          <tr key={variable.key}>
                            <td className="env-key-cell">
                              <code>{variable.key}</code>
                              {variable.isSecret && (
                                <span className="status-badge warning compact">
                                  Secret
                                </span>
                              )}
                              <span className="env-source-badge global">
                                Global
                              </span>
                            </td>
                            <td className="env-value-cell">
                              {variable.isSecret ? (
                                variable.hasValue ? (
                                  <span className="masked-value">••••••••</span>
                                ) : (
                                  <span className="text-faint">Not set</span>
                                )
                              ) : variable.hasValue ? (
                                <code>{variable.value}</code>
                              ) : (
                                <span className="text-faint">Empty</span>
                              )}
                            </td>
                            <td className="env-actions-cell">
                              <button
                                className="secondary-button compact"
                                type="button"
                                onClick={() => openOverrideDialog(variable)}
                              >
                                Override
                              </button>
                              <button
                                className="secondary-button compact"
                                type="button"
                                onClick={() => openMoveDialog("global-to-app", variable.key)}
                              >
                                Move to app
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="env-scope-block">
                <div className="env-scope-heading">
                  <h3>App-Specific Variables</h3>
                  <div className="env-scope-heading-actions">
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={() => {
                        setBulkEnvError("");
                        setShowBulkEnvDialog(true);
                      }}
                    >
                      Paste Variables
                    </button>
                    <button
                      className="primary-button compact"
                      type="button"
                      onClick={openCreateEnvDialog}
                    >
                      Add Variable
                    </button>
                  </div>
                </div>

                <EnvVarTable
                  variables={appVars}
                  emptyMessage="No app-specific variables yet. Add one, or override a global variable above."
                  onEdit={(variable) =>
                    openEditEnvDialog(variable as MaskedAppEnvVar)
                  }
                  onDelete={(variable) =>
                    setEnvDeleteTarget(variable as MaskedAppEnvVar)
                  }
                  busyId={envDeleting ? envDeleteTarget?.id ?? null : null}
                  extraAction={{
                    label: "Move to global",
                    onClick: (variable) => openMoveDialog("app-to-global", variable.key)
                  }}
                />

                {appVars.some((variable) =>
                  globalVars.some((globalVar) => globalVar.key === variable.key)
                ) && (
                  <p className="section-description">
                    Variables marked as overriding a global key take priority
                    over the inherited value for this app only.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "storage" && (
        <div className="app-detail-tab-panel">
          {storageError && <div className="error-banner">{storageError}</div>}

          <div className="env-scope-block">
            <div className="env-scope-heading">
              <h3>Persistent Storage</h3>
              <button
                className="primary-button compact"
                type="button"
                onClick={openCreateStorageDialog}
              >
                Add Storage
              </button>
            </div>
            <p className="section-description">
              Docker named volumes mounted into the container. Adding,
              editing, or removing a mount marks configuration as pending —
              use Redeploy above to apply it to the running container.
            </p>
          </div>

          {storageLoading && !storageLoaded ? (
            <div className="empty-state">Loading storage mounts...</div>
          ) : (
            <StorageTable
              volumes={storageVolumes}
              emptyMessage="No storage mounts yet. Add one to persist data across redeployments."
              onEdit={openEditStorageDialog}
              onDelete={(volume) => setStorageDeleteTarget(volume)}
              busyId={
                storageDeleting ? storageDeleteTarget?.id ?? null : null
              }
            />
          )}
        </div>
      )}

      {activeTab === "networking" && (
        <div className="app-detail-tab-panel">
          <div className="env-scope-block">
            <div className="env-scope-heading">
              <h3>Domain &amp; Routing</h3>
              <button
                className="secondary-button compact"
                type="button"
                onClick={() => {
                  setDomainError("");
                  setShowDomainDialog(true);
                }}
              >
                Edit domain
              </button>
            </div>
            <p className="section-description">
              How this app is reached — a public HTTPS domain, or internal-only
              on the platform's private network. Published ports expose raw
              TCP/UDP for non-HTTP services.
            </p>
            <dl className="app-detail-grid">
              <div>
                <dt>Public domain</dt>
                <dd className="domain-cell">
                  {detail.internalOnly ? (
                    <span className="routing-badge internal-only">Internal only</span>
                  ) : detail.domain ? (
                    <a className="public-domain-link" href={`https://${detail.domain}`} target="_blank" rel="noopener noreferrer">
                      {detail.domain}
                    </a>
                  ) : (
                    "Not assigned"
                  )}
                </dd>
              </div>
              <div>
                <dt>Routing</dt>
                <dd>
                  {detail.internalOnly
                    ? "Internal only — private network, no public route"
                    : detail.routingReady
                      ? "Public — routing ready"
                      : "Public — routing not ready"}
                </dd>
              </div>
              <div>
                <dt>Internal port</dt>
                <dd>{detail.containerPort}</dd>
              </div>
              {detail.publishedPorts.length > 0 && (
                <div>
                  <dt>Published ports</dt>
                  <dd>
                    {detail.publishedPorts.map((port) => (
                      <div key={`${port.hostPort}/${port.protocol}`} className="published-port-line">
                        <code>
                          {port.hostPort} → {port.containerPort}/{port.protocol}
                        </code>
                      </div>
                    ))}
                    <small className="text-faint">
                      Reachable on the server's public IP at the host port
                      (firewall permitting).
                    </small>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      )}

      {activeTab === "resources" && (
        <div className="app-detail-tab-panel">
          <ResourcesSection
            appId={appId}
            memoryLimitMb={detail.memoryLimitMb}
            cpuLimit={detail.cpuLimit}
            containerRunning={isRunning}
            onSaved={() => void loadDetail()}
          />
        </div>
      )}

      {activeTab === "health" && (
        <HealthPanel appId={appId} containerRunning={isRunning} />
      )}

      {activeTab === "metrics" && (
        <Suspense fallback={<div className="empty-state">Loading metrics...</div>}>
          <MetricsPanel appId={appId} containerRunning={isRunning} />
        </Suspense>
      )}

      {activeTab === "performance" && (
        <PerformanceDiagnosticsPanel appId={appId} publicDomain={detail.domain} />
      )}

      {/* Runtime (live SSE console) and the last Build log share one "Logs"
          group. Both stay mounted while the group is active and toggle via
          `hidden`, so peeking at the build log never tears down the live
          console stream or its retained buffer. */}
      {activeGroup.key === "logs" && (
        <>
          <div hidden={activeTab !== "console"}>
            <ConsolePanel appId={appId} />
          </div>
          <div hidden={activeTab !== "logs"}>
            <BuildLogPanel appId={appId} appName={detail.name} />
          </div>
        </>
      )}

      {activeTab === "history" && (
        <HistoryPanel
          appId={appId}
          onReverted={() => void loadDetail()}
          deploymentRetention={detail.deploymentRetention}
          onRetentionChanged={() => void loadDetail()}
        />
      )}

      {activeTab === "activity" && <ActivityPanel appId={appId} />}

      {activeTab === "irc-settings" && isIrcServerImage(detail.image) && (
        <IrcSettingsPanel appId={appId} containerRunning={isRunning} />
      )}

      {activeTab === "bot-settings" && isIrcBotImage(detail.image) && (
        <IrcBotSettingsPanel appId={appId} containerRunning={isRunning} />
      )}

      {activeTab === "blueprint" && isBlueprintImage(detail.image) && (
        <BlueprintPanel appId={appId} containerRunning={isRunning} />
      )}

      <EnvVarDialog
        open={showEnvDialog}
        title={
          editingVar
            ? `Edit ${editingVar.key}`
            : overrideKey
              ? `Override ${overrideKey}`
              : "Add App Variable"
        }
        description={
          overrideKey
            ? `This creates an app-specific value for "${overrideKey}" that takes priority over the global value.`
            : undefined
        }
        keyLocked={editingVar !== null || overrideKey !== null}
        initialValues={
          editingVar
            ? {
                key: editingVar.key,
                value: "",
                isSecret: editingVar.isSecret,
                enabled: editingVar.enabled
              }
            : overrideKey
              ? { key: overrideKey, value: "", isSecret: false, enabled: true }
              : undefined
        }
        secretValuePlaceholder={
          editingVar?.isSecret
            ? "Leave blank to keep the current secret value"
            : undefined
        }
        submitting={envSubmitting}
        error={envDialogError}
        onSubmit={(values) => void submitEnvDialog(values)}
        onCancel={() => setShowEnvDialog(false)}
      />

      <BulkEnvVarDialog
        open={showBulkEnvDialog}
        existingSecrets={
          new Map(appVars.map((variable) => [variable.key, variable.isSecret]))
        }
        submitting={bulkEnvSubmitting}
        error={bulkEnvError}
        onSubmit={(variables) => void submitBulkEnvDialog(variables)}
        onCancel={() => setShowBulkEnvDialog(false)}
      />

      <MoveVariableDialog
        open={moveTarget !== null}
        keyName={moveTarget?.key ?? ""}
        direction={moveTarget?.direction ?? "global-to-app"}
        submitting={moving}
        error={moveError}
        onDispose={(disposition) => void runMove(disposition)}
        onCancel={() => {
          if (!moving) {
            setMoveTarget(null);
          }
        }}
      />

      <EnvironmentExportDialog
        open={showEnvExportDialog}
        submitting={envExporting}
        error={envExportError}
        onSubmit={(password) => void copyEffectiveEnvironment(password)}
        onCancel={() => setShowEnvExportDialog(false)}
      />

      <DomainDialog
        open={showDomainDialog}
        currentDomain={detail.domain}
        currentInternalOnly={detail.internalOnly}
        submitting={domainSubmitting}
        error={domainError}
        onSubmit={(payload) => void submitDomainDialog(payload)}
        onCancel={() => setShowDomainDialog(false)}
      />

      <ConfirmationDialog
        open={envDeleteTarget !== null}
        title={`Delete ${envDeleteTarget?.key}?`}
        message={
          <p>
            This removes <strong>{envDeleteTarget?.key}</strong> from this
            app. If it was overriding a global variable, the app will fall
            back to the global value after redeploy.
          </p>
        }
        confirmLabel="Delete variable"
        danger
        confirming={envDeleting}
        onConfirm={() => void confirmEnvDelete()}
        onCancel={() => setEnvDeleteTarget(null)}
      />

      <StorageDialog
        open={showStorageDialog}
        title={editingVolume ? `Edit ${editingVolume.containerPath}` : "Add Storage Mount"}
        volumeNameLocked={editingVolume !== null}
        initialValues={
          editingVolume
            ? {
                containerPath: editingVolume.containerPath,
                volumeName: editingVolume.volumeName,
                readOnly: editingVolume.readOnly
              }
            : undefined
        }
        submitting={storageSubmitting}
        error={storageDialogError}
        onSubmit={(values) => void submitStorageDialog(values)}
        onCancel={() => setShowStorageDialog(false)}
      />

      <ConfirmationDialog
        open={storageDeleteTarget !== null}
        title={`Remove ${storageDeleteTarget?.containerPath}?`}
        message={
          <p>
            This removes the storage mount at{" "}
            <strong>{storageDeleteTarget?.containerPath}</strong> from this
            app. The underlying Docker volume{" "}
            <strong>{storageDeleteTarget?.volumeName}</strong> and its data
            are <strong>not</strong> deleted — only the platform's tracking
            record is removed.
          </p>
        }
        confirmLabel="Remove mount"
        danger
        confirming={storageDeleting}
        onConfirm={() => void confirmStorageDelete()}
        onCancel={() => setStorageDeleteTarget(null)}
      />

      <ConfirmationDialog
        open={showRedeployConfirm}
        title={`Redeploy ${detail.name}?`}
        message={
          <p>
            This pulls <strong>{detail.image}</strong> and replaces the
            running container with a new one using the current environment
            variables and storage mounts. The new container is started and
            verified before the old one is removed, but the app will
            briefly restart. This cannot be undone.
          </p>
        }
        confirmLabel="Redeploy app"
        confirming={actionLoading === "redeploy"}
        onConfirm={() => void confirmRedeploy()}
        onCancel={() => setShowRedeployConfirm(false)}
      />

      <ConfirmationDialog
        open={showDeleteConfirm}
        title={`Delete ${detail.name}?`}
        message={
          <>
            <p>
              This permanently removes the <strong>{detail.name}</strong>{" "}
              container and its anonymous volumes. This cannot be undone.
            </p>
            {storageVolumes.length > 0 && (
              <p className="warning-banner">
                This app has {storageVolumes.length} persistent named volume
                {storageVolumes.length === 1 ? "" : "s"}. Deleting the app
                removes its platform metadata only — the named volume
                {storageVolumes.length === 1 ? "" : "s"} will remain
                physically present on the server, and the platform cannot
                currently reattach an orphaned volume automatically.
                {detail.internalOnly &&
                  " This is an internal-only app, so note its volume name(s) before deleting if you may need to reattach the data later."}
              </p>
            )}
          </>
        }
        confirmLabel="Delete app"
        confirmingLabel="Deleting..."
        danger
        confirming={actionLoading === "delete"}
        error={showDeleteConfirm ? actionError : ""}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </section>
  );
}
