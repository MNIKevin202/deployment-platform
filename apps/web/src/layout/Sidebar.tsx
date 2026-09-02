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
}

export const NAV_ITEMS: { key: PrimarySection; label: string; glyph: string }[] = [
  { key: "overview", label: "Overview", glyph: "◈" },
  { key: "apps", label: "Apps", glyph: "▣" },
  { key: "resources", label: "Resources", glyph: "⇄" },
  { key: "automation", label: "Automation", glyph: "⏱" },
  { key: "platform", label: "Platform", glyph: "⛭" }
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

export default function Sidebar({ active, onSelect }: SidebarProps) {
  const activePrimary = active ? primaryOf(active) : null;

  return (
    <div className="sidebar-inner">
      <div className="sidebar-brand">
        <BrandMark className="sidebar-mark" />
        <div>
          <p className="sidebar-brand-name">ClovaForge</p>
          <p className="sidebar-brand-sub">Deploy Console</p>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`sidebar-nav-item ${activePrimary === item.key ? "active" : ""}`}
            aria-current={activePrimary === item.key ? "page" : undefined}
            onClick={() => onSelect(item.key)}
          >
            <span className="sidebar-nav-glyph" aria-hidden="true">
              {item.glyph}
            </span>
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
