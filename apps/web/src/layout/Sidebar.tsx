export type Section =
  | "overview"
  | "apps"
  | "databases"
  | "connections"
  | "templates"
  | "repositories"
  | "cron"
  | "environment"
  | "system"
  | "settings";

interface SidebarProps {
  active: Section | null;
  onSelect: (section: Section) => void;
}

export const NAV_ITEMS: { key: Section; label: string; glyph: string }[] = [
  { key: "overview", label: "Overview", glyph: "◈" },
  { key: "apps", label: "Apps", glyph: "▣" },
  { key: "databases", label: "Databases", glyph: "▤" },
  { key: "connections", label: "Connections", glyph: "⇄" },
  { key: "templates", label: "Templates", glyph: "◳" },
  { key: "repositories", label: "Repositories", glyph: "⌥" },
  { key: "cron", label: "Cron Jobs", glyph: "⏱" },
  { key: "environment", label: "Environment", glyph: "⚙" },
  { key: "system", label: "System", glyph: "◫" },
  { key: "settings", label: "Settings", glyph: "⛭" }
];

/** Every section that can be linked to via ?section=… — derived from the nav
 * itself, so a new page is deep-linkable the moment it appears there. */
export const SECTIONS: readonly Section[] = NAV_ITEMS.map((item) => item.key);

/** Narrows an untrusted ?section= value to a real Section. */
export function parseSection(value: string | null): Section | null {
  return SECTIONS.includes(value as Section) ? (value as Section) : null;
}

export default function Sidebar({ active, onSelect }: SidebarProps) {
  return (
    <div className="sidebar-inner">
      <div className="sidebar-brand">
        <img src="/icon-192.png" alt="" className="sidebar-mark" />
        <div>
          <p className="sidebar-brand-name">Deployment</p>
          <p className="sidebar-brand-sub">Platform</p>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`sidebar-nav-item ${active === item.key ? "active" : ""}`}
            aria-current={active === item.key ? "page" : undefined}
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
