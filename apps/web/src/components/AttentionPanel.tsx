import type { AttentionItem } from "../lib/platformHealth";
import type { StoredApp } from "../types/api";

/** Keeps the panel useful (not a wall of text) once a platform manages dozens/hundreds of apps. */
const MAX_VISIBLE_ITEMS = 10;

interface AttentionPanelProps {
  items: AttentionItem[];
  onViewApp: (storedApp: StoredApp) => void;
}

export default function AttentionPanel({ items, onViewApp }: AttentionPanelProps) {
  if (items.length === 0) {
    return (
      <div className="attention-panel">
        <div className="attention-empty" role="status">
          <span aria-hidden="true">✓</span>
          <span>All clear — nothing needs attention right now.</span>
        </div>
      </div>
    );
  }

  // Critical items lead, so the most urgent things are never pushed below the fold by the cap.
  const sorted = [...items].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
  const visible = sorted.slice(0, MAX_VISIBLE_ITEMS);
  const remaining = sorted.length - visible.length;

  return (
    <div className="attention-panel">
      {visible.map((item) => (
        <div key={item.id} className={`attention-item severity-${item.severity}`}>
          <span className="attention-item-dot" aria-hidden="true" />
          <span className="attention-item-message">{item.message}</span>
          {item.app && (
            <button
              type="button"
              className="secondary-button compact attention-item-action"
              onClick={() => onViewApp(item.app as StoredApp)}
            >
              View app →
            </button>
          )}
        </div>
      ))}
      {remaining > 0 && <p className="attention-more">+{remaining} more</p>}
    </div>
  );
}
