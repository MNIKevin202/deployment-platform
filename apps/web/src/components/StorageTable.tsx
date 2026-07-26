import type { StoredAppVolume } from "../types/api";

interface StorageTableProps {
  volumes: StoredAppVolume[];
  emptyMessage: string;
  onEdit: (volume: StoredAppVolume) => void;
  onDelete: (volume: StoredAppVolume) => void;
  busyId?: number | null;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function StorageTable({
  volumes,
  emptyMessage,
  onEdit,
  onDelete,
  busyId
}: StorageTableProps) {
  if (volumes.length === 0) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  return (
    <div className="table-wrap">
      <table className="env-table">
        <thead>
          <tr>
            <th>Container Path</th>
            <th>Volume Name</th>
            <th>Mode</th>
            <th>Updated</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {volumes.map((volume) => (
            <tr key={volume.id}>
              <td>
                <code>{volume.containerPath}</code>
              </td>
              <td>
                <code>{volume.volumeName}</code>
              </td>
              <td>
                <span
                  className={`status-badge compact ${volume.readOnly ? "warning" : "positive"}`}
                >
                  {volume.readOnly ? "Read-only" : "Read-write"}
                </span>
              </td>
              <td className="text-faint">{formatDate(volume.updatedAt)}</td>
              <td className="env-actions-cell">
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => onEdit(volume)}
                  disabled={busyId === volume.id}
                >
                  Edit
                </button>
                <button
                  className="danger-button compact"
                  type="button"
                  onClick={() => onDelete(volume)}
                  disabled={busyId === volume.id}
                >
                  {busyId === volume.id ? "Working..." : "Delete"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
