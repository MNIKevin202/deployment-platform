import type { MaskedGlobalEnvVar } from "../types/api";

interface EnvVarTableProps {
  variables: MaskedGlobalEnvVar[];
  emptyMessage: string;
  onEdit: (variable: MaskedGlobalEnvVar) => void;
  onDelete: (variable: MaskedGlobalEnvVar) => void;
  busyId?: number | null;
  /** Optional extra per-row action, shown before Edit (e.g. "Move to global"). */
  extraAction?: { label: string; onClick: (variable: MaskedGlobalEnvVar) => void };
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function EnvVarTable({
  variables,
  emptyMessage,
  onEdit,
  onDelete,
  busyId,
  extraAction
}: EnvVarTableProps) {
  if (variables.length === 0) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  return (
    <div className="table-wrap">
      <table className="env-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Status</th>
            <th>Updated</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {variables.map((variable) => (
            <tr key={variable.id}>
              <td className="env-key-cell">
                <code>{variable.key}</code>
                {variable.isSecret && (
                  <span className="status-badge warning compact">Secret</span>
                )}
              </td>
              <td className="env-value-cell">
                {variable.isSecret ? (
                  variable.hasValue ? (
                    <span className="masked-value">••••••••</span>
                  ) : (
                    <span className="text-faint">Not set</span>
                  )
                ) : variable.hasValue ? (
                  <code>{variable.value}</code>
                ) : (
                  <span className="text-faint">Empty</span>
                )}
              </td>
              <td>
                <span
                  className={`status-badge compact ${variable.enabled ? "positive" : "neutral"}`}
                >
                  {variable.enabled ? "Enabled" : "Disabled"}
                </span>
              </td>
              <td className="text-faint">{formatDate(variable.updatedAt)}</td>
              <td className="env-actions-cell">
                {extraAction && (
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={() => extraAction.onClick(variable)}
                    disabled={busyId === variable.id}
                  >
                    {extraAction.label}
                  </button>
                )}
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => onEdit(variable)}
                  disabled={busyId === variable.id}
                >
                  Edit
                </button>
                <button
                  className="danger-button compact"
                  type="button"
                  onClick={() => onDelete(variable)}
                  disabled={busyId === variable.id}
                >
                  {busyId === variable.id ? "Working..." : "Delete"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
