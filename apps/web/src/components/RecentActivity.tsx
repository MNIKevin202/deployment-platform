import type { StoredApp, DeploymentEventSeverity } from "../types/api";

interface RecentActivityProps {
  apps: StoredApp[];
  onViewApp: (app: StoredApp) => void;
  limit?: number;
}

type Row = {
  app: StoredApp;
  label: string;
  severity: DeploymentEventSeverity;
  at: string | null;
};

/** Turns an event type like "deploy_succeeded" into "Deploy succeeded". */
function humanizeEvent(type: string): string {
  const spaced = type.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Compact relative time ("3m", "2h", "5d"), full timestamp on hover. */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const SEVERITY_WORD: Record<DeploymentEventSeverity, string> = {
  info: "OK",
  warning: "Warning",
  error: "Failed"
};

/**
 * Recent activity across all apps, built from each stored app's own
 * `latestEventType` / `latestEventSeverity` / `lastDeployedAt` — real data the
 * dashboard already loads, no new backend. Shows the most recent events first.
 * Status is conveyed by an icon glyph + word, not color alone.
 */
export default function RecentActivity({ apps, onViewApp, limit = 6 }: RecentActivityProps) {
  const rows: Row[] = apps
    .filter((app) => app.latestEventType)
    .map((app) => ({
      app,
      label: humanizeEvent(app.latestEventType as string),
      severity: (app.latestEventSeverity ?? "info") as DeploymentEventSeverity,
      at: app.lastDeployedAt ?? app.updatedAt ?? null
    }))
    .sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime())
    .slice(0, limit);

  if (rows.length === 0) {
    return (
      <div className="activity-empty">
        <p>No recent deployment activity.</p>
      </div>
    );
  }

  return (
    <ul className="activity-list">
      {rows.map((row) => (
        <li key={row.app.id} className={`activity-row sev-${row.severity}`}>
          <span className="activity-glyph" aria-hidden="true">
            {row.severity === "error" ? "✕" : row.severity === "warning" ? "!" : "✓"}
          </span>
          <button type="button" className="activity-main" onClick={() => onViewApp(row.app)}>
            <span className="activity-app">{row.app.name}</span>
            <span className="activity-label">
              {row.label}
              <span className="sr-only">{` — ${SEVERITY_WORD[row.severity]}`}</span>
            </span>
          </button>
          {row.at && (
            <time className="activity-time" dateTime={row.at} title={new Date(row.at).toLocaleString()}>
              {relativeTime(row.at)}
            </time>
          )}
        </li>
      ))}
    </ul>
  );
}
