import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import { useAuth } from "./AuthGate";
import AppShell from "./layout/AppShell";
import Sidebar, { type Section } from "./layout/Sidebar";
import Header from "./layout/Header";
import Notice from "./components/Notice";
import LogViewer from "./components/LogViewer";
import AppDetail from "./components/AppDetail";
import CreateAppWizard from "./components/CreateAppWizard";
import OverviewPage from "./pages/OverviewPage";
import AppsPage from "./pages/AppsPage";
import RepositoriesPage from "./pages/RepositoriesPage";
import RepositoryDetail from "./components/RepositoryDetail";
import EnvironmentPage from "./pages/EnvironmentPage";
import SystemPage from "./pages/SystemPage";
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

const SECTION_TITLES: Record<Section, string> = {
  overview: "Overview",
  apps: "Apps",
  repositories: "Repositories",
  environment: "Environment",
  system: "System"
};

const SECTION_SUBTITLES: Record<Section, string> = {
  overview: "A snapshot of your platform and its managed applications.",
  apps: "Deploy and manage applications running on your server.",
  repositories: "Connect GitHub and browse repositories available for source-linked apps.",
  environment: "Variables inherited by every managed app, unless overridden.",
  system: "Protected platform services and host information."
};

function App() {
  const { username, logout } = useAuth();

  // The GitHub App callback (routes/github-app.ts) redirects the browser
  // back to a real page load at /?section=repositories&github=... — a plain
  // useState("overview") default would silently drop the user on Overview
  // and hide the connection result RepositoriesPage reads from the same
  // query string. Read the initial section from it once, synchronously,
  // so the very first render already lands on the right page.
  const [section, setSection] = useState<Section>(() => {
    const requested = new URLSearchParams(window.location.search).get("section");
    return requested === "apps" ||
      requested === "repositories" ||
      requested === "environment" ||
      requested === "system"
      ? requested
      : "overview";
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
  const [selectedRepo, setSelectedRepo] = useState<{ owner: string; name: string } | null>(null);

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

  const [showCreateApp, setShowCreateApp] = useState(false);

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

  const openCreateApp = () => {
    setError("");
    setNotice("");
    setShowCreateApp(true);
  };

  const viewApp = (storedApp: StoredApp) => {
    setError("");
    setNotice("");
    setSelectedAppId(storedApp.id);
  };

  const goToSection = (nextSection: Section) => {
    setSelectedAppId(null);
    setSelectedRepo(null);
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
    <button
      className="secondary-button"
      type="button"
      onClick={() => {
        if (section === "environment") {
          setEnvironmentRefreshKey((key) => key + 1);
        } else {
          void loadDashboard();
        }
      }}
    >
      Refresh
    </button>
  );

  return (
    <AppShell
      sidebar={<Sidebar active={section} onSelect={goToSection} />}
      header={
        <Header
          title={SECTION_TITLES[section]}
          subtitle={SECTION_SUBTITLES[section]}
          username={username}
          onLogout={() => void logout()}
          actions={headerActions}
        />
      }
    >
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      {section === "environment" ? (
        <EnvironmentPage refreshKey={environmentRefreshKey} />
      ) : section === "repositories" ? (
        selectedRepo ? (
          <RepositoryDetail
            owner={selectedRepo.owner}
            name={selectedRepo.name}
            onBack={() => setSelectedRepo(null)}
          />
        ) : (
          <RepositoriesPage onSelectRepository={(owner, name) => setSelectedRepo({ owner, name })} />
        )
      ) : loading ? (
        <div className="empty-state">Loading Docker information...</div>
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
          onCreateApp={openCreateApp}
        />
      ) : section === "apps" ? (
        <AppsPage
          managedApps={managedApps}
          storedAppsByName={storedAppsByName}
          actionLoading={actionLoading}
          onAction={(container, action) => void runAction(container, action)}
          onOpenLogs={(container) => setSelectedContainer(container)}
          onDeleteApp={(container) => void deleteApp(container)}
          onViewApp={viewApp}
          onCreateApp={openCreateApp}
        />
      ) : (
        <SystemPage
          systemContainers={systemContainers}
          dockerInfo={dockerInfo}
          actionLoading={actionLoading}
          onAction={(container, action) => void runAction(container, action)}
          onOpenLogs={(container) => setSelectedContainer(container)}
        />
      )}

      <CreateAppWizard
        open={showCreateApp}
        onClose={() => setShowCreateApp(false)}
        onCreated={(createdApp) => void handleAppCreated(createdApp)}
      />

      {selectedContainer && (
        <LogViewer
          containerId={selectedContainer.id}
          title={selectedContainer.names[0] ?? selectedContainer.shortId}
          onClose={() => setSelectedContainer(null)}
        />
      )}
    </AppShell>
  );
}

export default App;
