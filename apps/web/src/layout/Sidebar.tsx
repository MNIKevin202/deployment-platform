import BrandMark from "../components/BrandMark";

/**
 * Every routable destination. The sidebar shows only the five PRIMARY areas
 * (below); the remaining "legacy" keys stay valid so old deep links keep
 * working and so a primary area can open on a specific sub-tab
 * (e.g. ?section=connections opens Resources on its Connections tab).
 */
export type Section =
  | "overview"
  | "apps"
  | "resources"
  | "automation"
  | "platform"
  // legacy / sub-destinations — not shown in the sidebar, still deep-linkable
  | "databases"
  | "connections"
  | "templates"
  | "repositories"
  | "cron"
  | "environment"
  | "system"
  | "settings";

/** The five conceptual areas that appear in the sidebar. */
export type PrimarySection =
  | "overview"
  | "apps"
  | "resources"
  | "automation"
  | "platform";

interface SidebarProps {
  active: Section | null;
  onSelect: (section: Section) => void;
  username?: string;
}

/** SVG glyph (path data) per area, drawn in a small tile beside the label. */
const NAV_ICONS: Record<PrimarySection, string> = {
  overview: "M3 12l9-9 9 9M5 10v10h14V10",
  apps: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  resources:
    "M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  automation: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v4l3 2",
  platform:
    "M12 2a3 3 0 0 1 3 3 3 3 0 0 0 4.2 2.7 3 3 0 0 1 1.1 4.1A3 3 0 0 0 20 18a3 3 0 0 1-3.9 2.3A3 3 0 0 0 12 22a3 3 0 0 0-4.1-1.7A3 3 0 0 1 4 18a3 3 0 0 0-.3-4.2 3 3 0 0 1 1.1-4.1A3 3 0 0 0 9 5a3 3 0 0 1 3-3zM10 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0"
};

export const NAV_ITEMS: { key: PrimarySection; label: string; glyph: string }[] = [
  { key: "overview", label: "Overview", glyph: "◈" },
  { key: "apps", label: "Apps", glyph: "▣" },
  { key: "resources", label: "Resources", glyph: "⇄" },
  { key: "automation", label: "Automation", glyph: "⏱" },
  { key: "platform", label: "Platform", glyph: "⛭" }
];

/** Grouped for the sidebar; both groups draw from NAV_ITEMS. */
const NAV_GROUPS: { label: string; keys: PrimarySection[] }[] = [
  { label: "Workspace", keys: ["overview", "apps"] },
  { label: "Platform", keys: ["resources", "automation", "platform"] }
];

/** Every value ?section= may legitimately carry — primary areas plus the
 * legacy/sub keys that now open inside one of them. */
export const SECTIONS: readonly Section[] = [
  "overview",
  "apps",
  "resources",
  "automation",
  "platform",
  "databases",
  "connections",
  "templates",
  "repositories",
  "cron",
  "environment",
  "system",
  "settings"
];

/** Maps any section to the sidebar area that owns it, so a legacy deep link
 * still highlights the right nav item and shows the right title. */
const PRIMARY_OF: Record<Section, PrimarySection> = {
  overview: "overview",
  apps: "apps",
  databases: "apps",
  templates: "apps",
  resources: "resources",
  connections: "resources",
  environment: "resources",
  repositories: "resources",
  automation: "automation",
  cron: "automation",
  platform: "platform",
  system: "platform",
  settings: "platform"
};

export function primaryOf(section: Section): PrimarySection {
  return PRIMARY_OF[section];
}

/** Narrows an untrusted ?section= value to a real Section. */
export function parseSection(value: string | null): Section | null {
  return SECTIONS.includes(value as Section) ? (value as Section) : null;
}

export default function Sidebar({ active, onSelect, username }: SidebarProps) {
  const activePrimary = active ? primaryOf(active) : null;
  const labelOf = (key: PrimarySection) =>
    NAV_ITEMS.find((item) => item.key === key)?.label ?? key;
  const host =
    typeof window !== "undefined" ? window.location.hostname : "localhost";
  const initials = (username ?? "").trim().slice(0, 2).toUpperCase() || "CF";

  return (
    <div className="sidebar-inner">
      <div className="sidebar-brand">
        <BrandMark className="sidebar-mark" />
        <div>
          <p className="sidebar-brand-name">ClovaForge</p>
          <p className="sidebar-brand-sub">Deploy Console</p>
        </div>
      </div>

      <div className="sidebar-server" title={host}>
        <span className="sidebar-server-ring" aria-hidden="true">◐</span>
        <span className="sidebar-server-name">{host}</span>
        <span className="sidebar-live" aria-label="online" />
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="sidebar-nav-group">
            <p className="sidebar-nav-label">{group.label}</p>
            {group.keys.map((key) => {
              const isActive = activePrimary === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`sidebar-nav-item ${isActive ? "active" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => onSelect(key)}
                >
                  <span className="sidebar-nav-glyph" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d={NAV_ICONS[key]} />
                    </svg>
                  </span>
                  {labelOf(key)}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <span className="sidebar-avatar" aria-hidden="true">{initials}</span>
        <div className="sidebar-foot-id">
          <p className="sidebar-foot-name">{username || "Signed in"}</p>
          <p className="sidebar-foot-role">Owner</p>
        </div>
      </div>
    </div>
  );
}
