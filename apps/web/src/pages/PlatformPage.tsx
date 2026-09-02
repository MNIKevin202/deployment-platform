import { useState } from "react";
import Tabs from "../components/Tabs";
import SystemPage from "./SystemPage";
import SettingsPage, { SETTINGS_TABS, type SettingsTab } from "./SettingsPage";
import type {
  ContainerAction,
  ContainerSummary,
  DockerInfo
} from "../types/api";

type PlatformTab = "system" | SettingsTab;

const PLATFORM_TABS: { key: PlatformTab; label: string }[] = [
  { key: "system", label: "System" },
  ...SETTINGS_TABS
];

interface PlatformPageProps {
  initialTab?: PlatformTab;
  systemContainers: ContainerSummary[];
  dockerInfo: DockerInfo | null;
  actionLoading: string | null;
  onAction: (container: ContainerSummary, action: ContainerAction) => void;
  onOpenLogs: (container: ContainerSummary) => void;
}

/**
 * The "Platform" area is administration of the server itself: host/Docker
 * facts and protected services (System), plus every operator setting
 * (account, notifications, integrations, backups, maintenance, updates) —
 * all under one flat tab bar instead of two separate nav sections.
 */
export default function PlatformPage({
  initialTab = "system",
  systemContainers,
  dockerInfo,
  actionLoading,
  onAction,
  onOpenLogs
}: PlatformPageProps) {
  const [tab, setTab] = useState<PlatformTab>(initialTab);

  return (
    <div className="page">
      <Tabs items={PLATFORM_TABS} active={tab} onChange={(key) => setTab(key as PlatformTab)} />

      {tab === "system" ? (
        <SystemPage
          systemContainers={systemContainers}
          dockerInfo={dockerInfo}
          actionLoading={actionLoading}
          onAction={onAction}
          onOpenLogs={onOpenLogs}
        />
      ) : (
        <SettingsPage tab={tab} hideTabs />
      )}
    </div>
  );
}
