import { useState } from "react";
import Tabs from "../components/Tabs";
import ConnectionsPage from "./ConnectionsPage";
import EnvironmentPage from "./EnvironmentPage";
import RepositoriesPage from "./RepositoriesPage";
import RepositoryDetail from "../components/RepositoryDetail";

export type ResourcesTab = "connections" | "variables" | "github";

const RESOURCES_TABS: { key: ResourcesTab; label: string }[] = [
  { key: "connections", label: "Connections" },
  { key: "variables", label: "Global variables" },
  { key: "github", label: "GitHub" }
];

interface ResourcesPageProps {
  initialTab?: ResourcesTab;
  connectionsRefreshKey?: number;
  environmentRefreshKey?: number;
}

/**
 * The "Resources" area groups the shared inputs every app can consume —
 * external database connections, global environment variables, and the GitHub
 * source connection — behind one set of sub-tabs, instead of three separate
 * top-level nav items.
 */
export default function ResourcesPage({
  initialTab = "connections",
  connectionsRefreshKey = 0,
  environmentRefreshKey = 0
}: ResourcesPageProps) {
  const [tab, setTab] = useState<ResourcesTab>(initialTab);
  const [selectedRepo, setSelectedRepo] = useState<{ owner: string; name: string } | null>(null);

  return (
    <div className="page">
      <Tabs items={RESOURCES_TABS} active={tab} onChange={(key) => setTab(key as ResourcesTab)} />

      {tab === "connections" && <ConnectionsPage refreshKey={connectionsRefreshKey} />}

      {tab === "variables" && <EnvironmentPage refreshKey={environmentRefreshKey} />}

      {tab === "github" &&
        (selectedRepo ? (
          <RepositoryDetail
            owner={selectedRepo.owner}
            name={selectedRepo.name}
            onBack={() => setSelectedRepo(null)}
          />
        ) : (
          <RepositoriesPage
            onSelectRepository={(owner, name) => setSelectedRepo({ owner, name })}
          />
        ))}
    </div>
  );
}
