import type { StoredApp } from "../types/api";

interface MissingAppCardProps {
  storedApp: StoredApp;
  actionLoading: string | null;
  onViewApp: (storedApp: StoredApp) => void;
  onDeleteApp: (storedApp: StoredApp) => void;
  isFavorite?: boolean;
  onToggleFavorite?: (appId: number) => void;
}

/**
 * A card for a database-managed app whose Docker container is missing — the
 * record exists but its runtime is gone (a crashed, rolled-back, or
 * externally-removed container). It stays on the Apps page in a clear
 * recovery state rather than silently disappearing, and it never claims to
 * be "running". Recovery happens on the detail page (View App -> Source tab
 * -> Save changes and deploy), which recreates the container.
 */
export default function MissingAppCard({
  storedApp,
  actionLoading,
  onViewApp,
  onDeleteApp,
  isFavorite = false,
  onToggleFavorite
}: MissingAppCardProps) {
  const cardName = storedApp.containerName ?? storedApp.name;

  return (
    <article className="container-card missing-app-card">
      <div className="container-card-header">
        <div>
          <div className="title-row">
            {onToggleFavorite && (
              <button
                type="button"
                className="favorite-toggle"
                aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                aria-pressed={isFavorite}
                onClick={() => onToggleFavorite(storedApp.id)}
              >
                {isFavorite ? "★" : "☆"}
              </button>
            )}
            <h3>{cardName}</h3>
            <span className="type-badge missing">Recovery required</span>
          </div>

          <p>{storedApp.image}</p>
        </div>

        <div className="card-status">
          <span className="status-pill stopped">missing</span>
          <span className="card-status-detail">
            No running container — the runtime is gone
          </span>
        </div>
      </div>

      <dl className="container-details">
        <div>
          <dt>Status</dt>
          <dd>Container missing</dd>
        </div>

        {storedApp.internalOnly ? (
          <div>
            <dt>Routing</dt>
            <dd>
              <span className="routing-badge internal-only">Internal only</span>
            </dd>
          </div>
        ) : (
          storedApp.domain && (
            <div>
              <dt>Domain</dt>
              <dd>{storedApp.domain}</dd>
            </div>
          )
        )}
      </dl>

      <p className="protected-note">
        The container for this app is missing. Open it and use Deploy from
        GitHub (Source tab) to recreate the container.
      </p>

      <div className="container-actions card-actions">
        <button
          className="primary-button"
          type="button"
          onClick={() => onViewApp(storedApp)}
        >
          View App
        </button>

        <button
          className="danger-button"
          type="button"
          onClick={() => onDeleteApp(storedApp)}
          disabled={actionLoading === `app-${storedApp.id}:delete`}
        >
          {actionLoading === `app-${storedApp.id}:delete` ? "Deleting..." : "Delete"}
        </button>
      </div>
    </article>
  );
}
