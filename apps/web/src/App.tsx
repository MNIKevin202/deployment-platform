import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import { useAuth } from "./AuthGate";
import AppShell from "./layout/AppShell";
import Sidebar, {
  parseSection,
  primaryOf,
  type PrimarySection,
  type Section
} from "./layout/Sidebar";
import Header from "./layout/Header";
import Notice from "./components/Notice";
import LogViewer from "./components/LogViewer";
import AppDetail from "./components/AppDetail";
import CreateAppWizard from "./components/CreateAppWizard";
import TemplateGallery from "./components/TemplateGallery";
import DeploymentProgressOverlay from "./components/DeploymentProgressOverlay";
import type { AppTemplate } from "./lib/appTemplates";
import OverviewPage from "./pages/OverviewPage";
import AppsPage from "./pages/AppsPage";
import ResourcesPage, { type ResourcesTab } from "./pages/ResourcesPage";
import PlatformPage from "./pages/PlatformPage";
import type { SettingsTab } from "./pages/SettingsPage";
import CronPage from "./pages/CronPage";
import type {
  ApiError,
  ContainerAction,
  ContainerSummary,
  CreatedAppSummary,
  DockerInfo,
  RoutingStatus,
  StoredApp,
  StoredAppsResponse
} from "./types/api";

// Header copy is keyed by the five sidebar areas — a legacy deep link
// (?section=connections) opens inside its area and shows that area's title.
const AREA_TITLES: Record<PrimarySection, string> = {
  overview: "Overview",
  apps: "Apps",
  resources: "Resources",
  automation: "Automation",
  platform: "Platform"
};

const AREA_SUBTITLES: Record<PrimarySection, string> = {
  overview: "A snapshot of your platform and its managed applications.",
  apps: "Websites, services, bots, and databases running on your server.",
  resources: "Shared inputs your apps consume — connections, variables, and GitHub.",
  automation: "Scheduled commands that run inside your apps' containers.",
  platform: "The server itself — host, services, backups, and settings."
};

/** Which Resources sub-tab a section should open on. */
function resourcesTabFor(section: Section): ResourcesTab {
  if (section === "environment") return "variables";
  if (section === "repositories") return "github";
  return "connections";
}

/** Which Platform sub-tab a section should open on. */
function platformTabFor(section: Section): "system" | SettingsTab {
  return section === "settings" ? "account" : "system";
}

function App() {
  const { username, logout } = useAuth();

  // The GitHub App callback (routes/github-app.ts) redirects the browser
  // back to a real page load at /?section=repositories&github=... — a plain
  // useState("overview") default would silently drop the user on Overview
  // and hide the connection result RepositoriesPage reads from the same
  // query string. Read the initial section from it once, synchronously,
  // so the very first render already lands on the right page.
  const [section, setSection] = useState<Section>(() => {
    // Validated against the nav's own section list rather than a hand-kept
    // copy — the previous inline list silently omitted newer pages (cron,
    // templates), so linking to them landed on Overview instead.
    const requested = new URLSearchParams(window.location.search).get("section");
    return parseSection(requested) ?? "overview";
  });
  // Captured once, synchronously, in the same initial render as `section`
  // above — RepositoriesPage strips the "github" query param (via
  // history.replaceState) in its own effect, and effect ordering between
  // it and App's isn't something to depend on, so this reads the raw URL
  // before anything has a chance to mutate it.
  const [githubJustConnected] = useState<boolean>(
    () => new URLSearchParams(window.location.search).get("github") === "connected"
  );
  const [selectedAppId, setSelectedAppId] = useState<number | null>(null);

  const [dockerInfo, setDockerInfo] = useState<DockerInfo | null>(null);
  const [routingStatus, setRoutingStatus] = useState<RoutingStatus | null>(null);
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [storedApps, setStoredApps] = useState<StoredApp[]>([]);
  const [selectedContainer, setSelectedContainer] =
    useState<ContainerSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [environmentRefreshKey, setEnvironmentRefreshKey] = useState(0);
  const [connectionsRefreshKey, setConnectionsRefreshKey] = useState(0);
  const [checkingImageUpdates, setCheckingImageUpdates] = useState(false);

  const [showCreateApp, setShowCreateApp] = useState(false);
  const [templateSeed, setTemplateSeed] = useState<AppTemplate | null>(null);
  const [templateModel, setTemplateModel] = useState<string | null>(null);

  const systemContainers = useMemo(
    () => containers.filter((container) => container.isSystemContainer),
    [containers]
  );

  const managedApps = useMemo(
    () => containers.filter((container) => container.isManagedApp),
    [containers]
  );

  const storedAppsByName = useMemo(() => {
    const map = new Map<string, StoredApp>();

    for (const storedApp of storedApps) {
      map.set(storedApp.name, storedApp);
    }

    return map;
  }, [storedApps]);

  // Database-managed apps whose Docker container is gone (runtime.present is
  // explicitly false). These have no ContainerSummary in the live container
  // list, so without this they would vanish from the Apps page entirely.
  // `runtime == null` means Docker state is unknown (couldn't be queried) —
  // those are NOT treated as missing, to avoid a transient Docker hiccup
  // flipping every app into a recovery state.
  const missingApps = useMemo(
    () => storedApps.filter((storedApp) => storedApp.runtime?.present === false),
    [storedApps]
  );

  const loadDashboard = useCallback(async () => {
    try {
      const [infoResponse, containersResponse, appsResponse, routingResponse] =
        await Promise.all([
          fetch("/api/docker/info"),
          fetch("/api/containers"),
          fetch("/api/apps"),
          fetch("/api/routing/status")
        ]);

      if (!infoResponse.ok || !containersResponse.ok || !appsResponse.ok) {
        throw new Error("Unable to load Docker information");
      }

      const info = (await infoResponse.json()) as DockerInfo;
      const containerList =
        (await containersResponse.json()) as ContainerSummary[];
      const appsResult =
        (await appsResponse.json()) as StoredAppsResponse;

      setDockerInfo(info);
      setContainers(containerList);
      setStoredApps(appsResult.apps ?? []);

      if (routingResponse.ok) {
        setRoutingStatus((await routingResponse.json()) as RoutingStatus);
      }

      setSelectedContainer((currentSelection) => {
        if (!currentSelection) {
          return null;
        }

        return (
          containerList.find(
            (container) => container.id === currentSelection.id
          ) ?? null
        );
      });

      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load dashboard"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const updateAllApps = useCallback(
    async (list: ContainerSummary[]) => {
      const appsToUpdate = list
        .map((container) => {
          const appName = container.labels["com.deployment-platform.app-name"];
          return appName ? storedAppsByName.get(appName) : undefined;
        })
        .filter((storedApp): storedApp is StoredApp => Boolean(storedApp?.imageUpdateAvailable));

      if (appsToUpdate.length === 0) {
        return;
      }

      const confirmed = window.confirm(
        `Redeploy ${appsToUpdate.length} app${appsToUpdate.length === 1 ? "" : "s"} to pick up ${appsToUpdate.length === 1 ? "its" : "their"} newer image${appsToUpdate.length === 1 ? "" : "s"}?\n\n${appsToUpdate.map((storedApp) => storedApp.name).join(", ")}`
      );
      if (!confirmed) {
        return;
      }

      setError("");
      setNotice("");
      setActionLoading("update-all");

      let succeeded = 0;
      const failed: string[] = [];

      for (const storedApp of appsToUpdate) {
        try {
          const response = await fetch(`/api/apps/${storedApp.id}/redeploy`, { method: "POST" });
          if (!response.ok) {
            throw new Error(await getApiError(response, "Redeploy failed"));
          }
          succeeded += 1;
        } catch {
          failed.push(storedApp.name);
        }
      }

      await loadDashboard();
      setActionLoading(null);

      if (failed.length === 0) {
        setNotice(`Redeployed ${succeeded} app${succeeded === 1 ? "" : "s"}.`);
      } else {
        setError(`Redeployed ${succeeded}, but failed for: ${failed.join(", ")}.`);
      }
    },
    [storedAppsByName, loadDashboard]
  );

  const checkForImageUpdates = useCallback(async () => {
    setCheckingImageUpdates(true);
    setError("");

    try {
      const response = await fetch("/api/apps/image-updates/check-now", { method: "POST" });
      const result = (await response.json()) as { success: boolean; updatesAvailable?: number; message?: string };

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Update check failed");
      }

      await loadDashboard();

      setNotice(
        result.updatesAvailable
          ? `${result.updatesAvailable} app${result.updatesAvailable === 1 ? "" : "s"} ${result.updatesAvailable === 1 ? "has" : "have"} an update available.`
          : "All apps are up to date."
      );
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "Unable to check for updates");
    } finally {
      setCheckingImageUpdates(false);
    }
  }, [loadDashboard]);

  useEffect(() => {
    void loadDashboard();

    const interval = window.setInterval(() => {
      void loadDashboard();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [loadDashboard]);

  // Reopens the Create App wizard after a GitHub App connect round trip —
  // see the matching sessionStorage.setItem in CreateAppWizard.tsx's
  // "Connect GitHub" link. That navigation is a full page reload (GitHub's
  // own redirect flow), so this is a best-effort "you were in the middle
  // of creating an app" signal, not a restoration of every field the
  // wizard had — the wizard itself always starts fresh, just already open
  // and past the initial empty state, with GitHub already connected.
  useEffect(() => {
    if (window.sessionStorage.getItem("dp_resume_create_app_wizard") === "1") {
      window.sessionStorage.removeItem("dp_resume_create_app_wizard");
      if (githubJustConnected) {
        setShowCreateApp(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getApiError = async (
    response: Response,
    fallbackMessage: string
  ): Promise<string> => {
    try {
      const result = (await response.json()) as ApiError;
      return result.message || fallbackMessage;
    } catch {
      return fallbackMessage;
    }
  };

  const runAction = async (
    container: ContainerSummary,
    action: ContainerAction
  ) => {
    try {
      setError("");
      setNotice("");
      setActionLoading(`${container.id}:${action}`);

      const response = await fetch(
        `/api/containers/${container.id}/${action}`,
        {
          method: "POST"
        }
      );

      if (!response.ok) {
        throw new Error(
          await getApiError(
            response,
            `Unable to ${action} container`
          )
        );
      }

      setNotice(
        `${container.names[0] ?? container.shortId} ${action} completed.`
      );

      await loadDashboard();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Container action failed"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const runBulkAction = async (
    selectedContainers: ContainerSummary[],
    action: "start" | "stop"
  ): Promise<boolean> => {
    setError("");
    setNotice("");
    setActionLoading(`bulk:${action}`);

    let succeeded = 0;
    const failed: string[] = [];

    try {
      for (const container of selectedContainers) {
        const name = (container.names[0] ?? container.shortId).replace(/^\//, "");
        try {
          const response = await fetch(`/api/containers/${container.id}/${action}`, {
            method: "POST"
          });
          if (!response.ok) {
            throw new Error(await getApiError(response, `Unable to ${action} app`));
          }
          succeeded += 1;
        } catch {
          failed.push(name);
        }
      }

      await loadDashboard();

      if (failed.length === 0) {
        setNotice(
          `${action === "start" ? "Started" : "Stopped"} ${succeeded} app${succeeded === 1 ? "" : "s"}.`
        );
        return true;
      }

      setError(
        `${action === "start" ? "Started" : "Stopped"} ${succeeded}, but failed for: ${failed.join(", ")}.`
      );
      return false;
    } finally {
      setActionLoading(null);
    }
  };

  const redeployApp = async (storedApp: StoredApp) => {
    try {
      setError("");
      setNotice("");
      setActionLoading(`app-${storedApp.id}:redeploy`);

      const response = await fetch(`/api/apps/${storedApp.id}/redeploy`, {
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(await getApiError(response, "Unable to redeploy app"));
      }

      const result = (await response.json().catch(() => null)) as { message?: string } | null;
      setNotice(result?.message || `${storedApp.name} redeployed.`);
      await loadDashboard();
    } catch (redeployError) {
      setError(
        redeployError instanceof Error ? redeployError.message : "Unable to redeploy app"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleAppCreated = async (createdApp: CreatedAppSummary) => {
    setShowCreateApp(false);
    setNotice(`${createdApp.name} was created successfully.`);
    setError("");
    await loadDashboard();
    setSelectedAppId(createdApp.id);
  };

  const deleteApp = async (container: ContainerSummary) => {
    const containerName =
      container.names[0] ?? container.shortId;

    const confirmed = window.confirm(
      `Delete ${containerName}?\n\nThe container and its anonymous volumes will be removed.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setError("");
      setNotice("");
      setActionLoading(`${container.id}:delete`);

      const response = await fetch(`/api/apps/${container.id}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(
          await getApiError(response, "Unable to delete app")
        );
      }

      setNotice(`${containerName} was deleted.`);
      await loadDashboard();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete app"
      );
    } finally {
      setActionLoading(null);
    }
  };

  // Delete for an app whose container is missing: resolved by app id (there
  // is no live container id to target), tolerating an already-gone runtime.
  const deleteMissingApp = async (storedApp: StoredApp) => {
    const confirmed = window.confirm(
      `Delete ${storedApp.containerName ?? storedApp.name}?\n\nThis removes the app's configuration. Its container is already missing.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setError("");
      setNotice("");
      setActionLoading(`app-${storedApp.id}:delete`);

      const response = await fetch(`/api/apps/by-app-id/${storedApp.id}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(await getApiError(response, "Unable to delete app"));
      }

      setNotice(`${storedApp.name} was deleted.`);
      await loadDashboard();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "Unable to delete app"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const deleteAppsBulk = async (
    selectedContainers: ContainerSummary[],
    selectedMissingApps: StoredApp[]
  ): Promise<boolean> => {
    const names = [
      ...selectedContainers.map((container) =>
        (container.names[0] ?? container.shortId).replace(/^\//, "")
      ),
      ...selectedMissingApps.map((app) => app.name)
    ];

    const confirmed = window.confirm(
      `Delete ${names.length} selected app${names.length === 1 ? "" : "s"}?\n\n${names.join(", ")}\n\nTheir containers, anonymous volumes, and saved app configuration will be removed.`
    );
    if (!confirmed) {
      return false;
    }

    setError("");
    setNotice("");
    setActionLoading("bulk:delete");

    let succeeded = 0;
    const failed: string[] = [];

    try {
      for (const container of selectedContainers) {
        const name = (container.names[0] ?? container.shortId).replace(/^\//, "");
        try {
          const response = await fetch(`/api/apps/${container.id}`, {
            method: "DELETE",
            headers: { "Idempotency-Key": crypto.randomUUID() }
          });
          if (!response.ok) {
            throw new Error(await getApiError(response, "Unable to delete app"));
          }
          succeeded += 1;
        } catch {
          failed.push(name);
        }
      }

      for (const storedApp of selectedMissingApps) {
        try {
          const response = await fetch(`/api/apps/by-app-id/${storedApp.id}`, {
            method: "DELETE"
          });
          if (!response.ok) {
            throw new Error(await getApiError(response, "Unable to delete app"));
          }
          succeeded += 1;
        } catch {
          failed.push(storedApp.name);
        }
      }

      await loadDashboard();

      if (failed.length === 0) {
        setNotice(`Deleted ${succeeded} app${succeeded === 1 ? "" : "s"}.`);
        return true;
      }

      setError(`Deleted ${succeeded}, but failed for: ${failed.join(", ")}.`);
      return false;
    } finally {
      setActionLoading(null);
    }
  };

  const openCreateApp = () => {
    setError("");
    setNotice("");
    setTemplateSeed(null);
    setShowCreateApp(true);
  };

  const selectTemplate = (template: AppTemplate, options?: { model?: string | null }) => {
    setError("");
    setNotice("");
    setTemplateSeed(template);
    setTemplateModel(options?.model ?? null);
    setShowCreateApp(true);
  };

  const viewApp = (storedApp: StoredApp) => {
    setError("");
    setNotice("");
    setSelectedAppId(storedApp.id);
  };

  const goToSection = (nextSection: Section) => {
    setSelectedAppId(null);
    setSection(nextSection);
  };

  if (selectedAppId !== null) {
    return (
      <AppShell
        sidebar={<Sidebar active={null} onSelect={goToSection} />}
        header={
          <Header
            title="App Detail"
            username={username}
            onLogout={() => void logout()}
          />
        }
      >
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}

        <AppDetail
          appId={selectedAppId}
          onBack={() => setSelectedAppId(null)}
          onDeleted={() => {
            setSelectedAppId(null);
            setNotice("App was deleted.");
            void loadDashboard();
          }}
          onAppChanged={() => void loadDashboard()}
          onGoToGlobalEnvironment={() => goToSection("environment")}
        />
      </AppShell>
    );
  }

  const headerActions = (
    <>
      <button
        className="secondary-button"
        type="button"
        onClick={() => void checkForImageUpdates()}
        disabled={checkingImageUpdates}
      >
        {checkingImageUpdates ? "Checking..." : "Check for Updates"}
      </button>
      <button
        className="secondary-button"
        type="button"
        onClick={() => {
          if (primaryOf(section) === "resources") {
            setEnvironmentRefreshKey((key) => key + 1);
            setConnectionsRefreshKey((key) => key + 1);
          } else {
            void loadDashboard();
          }
        }}
      >
        Refresh
      </button>
    </>
  );

  return (
    <AppShell
      sidebar={<Sidebar active={section} onSelect={goToSection} />}
      header={
        <Header
          title={AREA_TITLES[primaryOf(section)]}
          subtitle={AREA_SUBTITLES[primaryOf(section)]}
          username={username}
          onLogout={() => void logout()}
          actions={headerActions}
        />
      }
    >
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      {primaryOf(section) === "resources" ? (
        <ResourcesPage
          initialTab={resourcesTabFor(section)}
          connectionsRefreshKey={connectionsRefreshKey}
          environmentRefreshKey={environmentRefreshKey}
        />
      ) : primaryOf(section) === "automation" ? (
        <CronPage apps={storedApps} />
      ) : section === "templates" ? (
        <TemplateGallery
          onSelect={selectTemplate}
          storedApps={storedApps}
          hostInfo={dockerInfo}
          onViewApp={(appId) => {
            const storedApp = storedApps.find((app) => app.id === appId);
            if (storedApp) {
              viewApp(storedApp);
            }
          }}
        />
      ) : loading ? (
        <div className="empty-state">Loading Docker information...</div>
      ) : primaryOf(section) === "platform" ? (
        <PlatformPage
          initialTab={platformTabFor(section)}
          systemContainers={systemContainers}
          dockerInfo={dockerInfo}
          actionLoading={actionLoading}
          onAction={(container, action) => void runAction(container, action)}
          onOpenLogs={(container) => setSelectedContainer(container)}
        />
      ) : section === "overview" ? (
        <OverviewPage
          dockerInfo={dockerInfo}
          routingStatus={routingStatus}
          managedApps={managedApps}
          storedAppsByName={storedAppsByName}
          actionLoading={actionLoading}
          onAction={(container, action) => void runAction(container, action)}
          onOpenLogs={(container) => setSelectedContainer(container)}
          onDeleteApp={(container) => void deleteApp(container)}
          onViewApp={viewApp}
          onRedeployApp={(storedApp) => void redeployApp(storedApp)}
          onCreateApp={openCreateApp}
          onBrowseTemplates={() => goToSection("templates")}
        />
      ) : (
        <AppsPage
          managedApps={managedApps}
          storedAppsByName={storedAppsByName}
          missingApps={missingApps}
          actionLoading={actionLoading}
          onAction={(container, action) => void runAction(container, action)}
          onOpenLogs={(container) => setSelectedContainer(container)}
          onDeleteApp={(container) => void deleteApp(container)}
          onDeleteMissingApp={(storedApp) => void deleteMissingApp(storedApp)}
          onViewApp={viewApp}
          onCreateApp={openCreateApp}
          onBrowseTemplates={() => goToSection("templates")}
          onUpdateAll={(list) => void updateAllApps(list)}
          updateAllLoading={actionLoading === "update-all"}
          onBulkAction={runBulkAction}
          onBulkDelete={deleteAppsBulk}
          initialType={section === "databases" ? "databases" : "all"}
        />
      )}

      <CreateAppWizard
        open={showCreateApp}
        initialTemplate={templateSeed}
        initialModel={templateModel}
        onClose={() => {
          setShowCreateApp(false);
          setTemplateSeed(null);
          setTemplateModel(null);
        }}
        onCreated={(createdApp) => void handleAppCreated(createdApp)}
      />

      {selectedContainer && (
        <LogViewer
          containerId={selectedContainer.id}
          title={selectedContainer.names[0] ?? selectedContainer.shortId}
          onClose={() => setSelectedContainer(null)}
        />
      )}

      {/*
        Mounted here, at the shell level, rather than inside any page — a
        deployment must stay visible while the operator moves between
        Overview, Apps, Settings, and so on.
      */}
      <DeploymentProgressOverlay
        onViewApp={(appId) => {
          const storedApp = storedApps.find((item) => item.id === appId);
          if (storedApp) {
            viewApp(storedApp);
          }
        }}
      />
    </AppShell>
  );
}

export default App;
