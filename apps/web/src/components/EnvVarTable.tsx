import { useMemo, useState } from "react";
import type { MaskedGlobalEnvVar } from "../types/api";
import EnvValueCell from "./EnvValueCell";
import { groupPrefix } from "../lib/envSecrets";

interface EnvVarTableProps {
  variables: MaskedGlobalEnvVar[];
  emptyMessage: string;
  onEdit: (variable: MaskedGlobalEnvVar) => void;
  onDelete: (variable: MaskedGlobalEnvVar) => void;
  busyId?: number | null;
  /** Optional extra per-row action, shown before Edit (e.g. "Move to global"). */
  extraAction?: { label: string; onClick: (variable: MaskedGlobalEnvVar) => void };
  /** When provided, renders a leading checkbox column for bulk selection. */
  selection?: {
    selectedKeys: ReadonlySet<string>;
    onToggle: (key: string) => void;
    onToggleAll: () => void;
  };
}

/** Below this many variables the search / sort / group controls add more
 *  noise than they save, so the table renders plainly. */
const TOOLBAR_THRESHOLD = 4;
/** Group by key prefix automatically once the list is long enough to benefit. */
const AUTO_GROUP_THRESHOLD = 7;

type SortColumn = "key" | "updated";
type SortDirection = "asc" | "desc";

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/** Compact "updated" label — a short date, with the full timestamp on hover. */
function formatDateShort(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function EditIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.3 2.7l2 2L6 12l-2.6.6L4 10z" />
    </svg>
  );
}

function MoveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 11l6-6" />
      <path d="M6 5h5v5" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5h10" />
      <path d="M6.5 4.5V3h3v1.5" />
      <path d="M4.6 4.5l.5 8a1 1 0 001 .95h3.8a1 1 0 001-.95l.5-8" />
    </svg>
  );
}

export default function EnvVarTable({
  variables,
  emptyMessage,
  onEdit,
  onDelete,
  busyId,
  extraAction,
  selection
}: EnvVarTableProps) {
  const [query, setQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("key");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [grouped, setGrouped] = useState(variables.length >= AUTO_GROUP_THRESHOLD);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    new Set()
  );

  const columnCount = (selection ? 1 : 0) + 5;

  const sorted = useMemo(() => {
    const copy = [...variables];
    copy.sort((a, b) => {
      let result: number;
      if (sortColumn === "key") {
        result = a.key.localeCompare(b.key, undefined, { sensitivity: "base" });
      } else {
        result =
          new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      }
      return sortDirection === "asc" ? result : -result;
    });
    return copy;
  }, [variables, sortColumn, sortDirection]);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return sorted;
    }
    return sorted.filter((variable) => {
      if (variable.key.toLowerCase().includes(trimmed)) {
        return true;
      }
      // Only match on values we actually hold (never on a masked secret).
      return (
        !variable.isSecret &&
        variable.value !== null &&
        variable.value.toLowerCase().includes(trimmed)
      );
    });
  }, [sorted, query]);

  // Groups, ordered by prefix; any prefix with a single member is folded into
  // a trailing "Other" bucket so a wall of one-row groups never forms.
  const groups = useMemo(() => {
    const byPrefix = new Map<string, MaskedGlobalEnvVar[]>();
    for (const variable of filtered) {
      const prefix = groupPrefix(variable.key);
      const bucket = byPrefix.get(prefix);
      if (bucket) {
        bucket.push(variable);
      } else {
        byPrefix.set(prefix, [variable]);
      }
    }

    const named: Array<{ prefix: string; variables: MaskedGlobalEnvVar[] }> = [];
    const loners: MaskedGlobalEnvVar[] = [];
    for (const [prefix, bucket] of byPrefix) {
      if (bucket.length === 1) {
        loners.push(bucket[0]);
      } else {
        named.push({ prefix, variables: bucket });
      }
    }
    named.sort((a, b) => a.prefix.localeCompare(b.prefix));
    if (loners.length > 0) {
      named.push({ prefix: "Other", variables: loners });
    }
    return named;
  }, [filtered]);

  if (variables.length === 0) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  const showToolbar = variables.length >= TOOLBAR_THRESHOLD;

  const allSelected =
    selection !== undefined &&
    variables.length > 0 &&
    variables.every((variable) => selection.selectedKeys.has(variable.key));

  const toggleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((previous) => (previous === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  };

  const sortIndicator = (column: SortColumn) => {
    if (sortColumn !== column) {
      return "";
    }
    return sortDirection === "asc" ? " ▲" : " ▼";
  };

  const toggleGroup = (prefix: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
      }
      return next;
    });
  };

  const allCollapsed =
    groups.length > 0 && groups.every((group) => collapsedGroups.has(group.prefix));

  const setAllCollapsed = (collapsed: boolean) => {
    setCollapsedGroups(
      collapsed ? new Set(groups.map((group) => group.prefix)) : new Set()
    );
  };

  const renderRow = (variable: MaskedGlobalEnvVar) => (
    <tr key={variable.id}>
      {selection && (
        <td className="env-select-cell">
          <input
            type="checkbox"
            aria-label={`Select ${variable.key}`}
            checked={selection.selectedKeys.has(variable.key)}
            onChange={() => selection.onToggle(variable.key)}
          />
        </td>
      )}
      <td className="env-key-cell">
        <code>{variable.key}</code>
        {variable.isSecret && (
          <span className="status-badge warning compact">Secret</span>
        )}
      </td>
      <td className="env-value-cell">
        <EnvValueCell
          keyName={variable.key}
          value={variable.value}
          hasValue={variable.hasValue}
          isSecret={variable.isSecret}
        />
      </td>
      <td>
        <span
          className={`status-badge compact ${variable.enabled ? "positive" : "neutral"}`}
        >
          {variable.enabled ? "Enabled" : "Disabled"}
        </span>
      </td>
      <td className="text-faint env-updated-cell" title={formatDate(variable.updatedAt)}>
        {formatDateShort(variable.updatedAt)}
      </td>
      <td className="env-actions-cell">
        {extraAction && (
          <button
            className="icon-button compact"
            type="button"
            aria-label={extraAction.label}
            title={extraAction.label}
            onClick={() => extraAction.onClick(variable)}
            disabled={busyId === variable.id}
          >
            <MoveIcon />
          </button>
        )}
        <button
          className="icon-button compact"
          type="button"
          aria-label="Edit"
          title="Edit"
          onClick={() => onEdit(variable)}
          disabled={busyId === variable.id}
        >
          <EditIcon />
        </button>
        <button
          className="icon-button compact danger"
          type="button"
          aria-label="Delete"
          title="Delete"
          onClick={() => onDelete(variable)}
          disabled={busyId === variable.id}
        >
          <DeleteIcon />
        </button>
      </td>
    </tr>
  );

  return (
    <div className="env-var-table">
      {showToolbar && (
        <div className="env-toolbar">
          <input
            type="search"
            className="env-search"
            placeholder="Filter variables…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter variables"
          />
          <div className="env-toolbar-right">
            <span className="env-count text-faint">
              {query.trim()
                ? `${filtered.length} of ${variables.length}`
                : `${variables.length} variable${variables.length === 1 ? "" : "s"}`}
            </span>
            {grouped && filtered.length > 0 && (
              <button
                type="button"
                className="secondary-button compact"
                onClick={() => setAllCollapsed(!allCollapsed)}
              >
                {allCollapsed ? "Expand all" : "Collapse all"}
              </button>
            )}
            <button
              type="button"
              className={`secondary-button compact${grouped ? " is-active" : ""}`}
              aria-pressed={grouped}
              onClick={() => setGrouped((previous) => !previous)}
            >
              Group
            </button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="empty-state">
          No variables match “{query.trim()}”.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="env-table">
            <thead>
              <tr>
                {selection && (
                  <th className="env-select-cell">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      onChange={selection.onToggleAll}
                    />
                  </th>
                )}
                <th>
                  <button
                    type="button"
                    className="env-sort-btn"
                    onClick={() => toggleSort("key")}
                  >
                    Key{sortIndicator("key")}
                  </button>
                </th>
                <th>Value</th>
                <th>Status</th>
                <th>
                  <button
                    type="button"
                    className="env-sort-btn"
                    onClick={() => toggleSort("updated")}
                  >
                    Updated{sortIndicator("updated")}
                  </button>
                </th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            {grouped ? (
              groups.map((group) => {
                const collapsed = collapsedGroups.has(group.prefix);
                return (
                  <tbody key={group.prefix} className="env-group">
                    <tr className="env-group-row">
                      <td colSpan={columnCount}>
                        <button
                          type="button"
                          className="env-group-toggle"
                          aria-expanded={!collapsed}
                          onClick={() => toggleGroup(group.prefix)}
                        >
                          <span className={`env-group-chevron${collapsed ? "" : " open"}`}>
                            ▸
                          </span>
                          <span className="env-group-name">{group.prefix}</span>
                          <span className="env-group-count">{group.variables.length}</span>
                        </button>
                      </td>
                    </tr>
                    {!collapsed && group.variables.map(renderRow)}
                  </tbody>
                );
              })
            ) : (
              <tbody>{filtered.map(renderRow)}</tbody>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
