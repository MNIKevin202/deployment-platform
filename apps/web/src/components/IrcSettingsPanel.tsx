import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  IrcMotdResponse,
  IrcOperator,
  IrcOperatorRole,
  IrcOperatorsResponse
} from "../types/api";

interface IrcSettingsPanelProps {
  appId: number;
  containerRunning: boolean;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

const ROLE_LABELS: Record<IrcOperatorRole, string> = {
  admin: "Admin",
  moderator: "Moderator"
};

export default function IrcSettingsPanel({ appId, containerRunning }: IrcSettingsPanelProps) {
  const [operators, setOperators] = useState<IrcOperator[] | null>(null);
  const [operatorsLoading, setOperatorsLoading] = useState(true);
  const [operatorsError, setOperatorsError] = useState("");

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<IrcOperatorRole>("moderator");
  const [addingOperator, setAddingOperator] = useState(false);
  const [addError, setAddError] = useState("");
  const [removingUsername, setRemovingUsername] = useState<string | null>(null);

  const [motd, setMotd] = useState("");
  const [motdLoading, setMotdLoading] = useState(true);
  const [motdError, setMotdError] = useState("");
  const [motdSaving, setMotdSaving] = useState(false);
  const [motdSaved, setMotdSaved] = useState(false);

  const loadOperators = useCallback(async () => {
    setOperatorsLoading(true);
    setOperatorsError("");

    try {
      const response = await fetch(`/api/apps/${appId}/irc/operators`);
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load operators"));
      }
      const result = (await response.json()) as IrcOperatorsResponse;
      setOperators(result.operators);
    } catch (error) {
      setOperatorsError(error instanceof Error ? error.message : "Unable to load operators");
    } finally {
      setOperatorsLoading(false);
    }
  }, [appId]);

  const loadMotd = useCallback(async () => {
    setMotdLoading(true);
    setMotdError("");

    try {
      const response = await fetch(`/api/apps/${appId}/irc/motd`);
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load the MOTD"));
      }
      const result = (await response.json()) as IrcMotdResponse;
      setMotd(result.content);
    } catch (error) {
      setMotdError(error instanceof Error ? error.message : "Unable to load the MOTD");
    } finally {
      setMotdLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    if (!containerRunning) {
      setOperatorsLoading(false);
      setMotdLoading(false);
      return;
    }
    void loadOperators();
    void loadMotd();
  }, [containerRunning, loadOperators, loadMotd]);

  const addOperator = async (event: React.FormEvent) => {
    event.preventDefault();
    setAddError("");
    setAddingOperator(true);

    try {
      const response = await fetch(`/api/apps/${appId}/irc/operators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, role: newRole })
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to add operator"));
      }

      const result = (await response.json()) as IrcOperatorsResponse;
      setOperators(result.operators);
      setNewUsername("");
      setNewPassword("");
      setNewRole("moderator");
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Unable to add operator");
    } finally {
      setAddingOperator(false);
    }
  };

  const removeOperator = async (username: string) => {
    setRemovingUsername(username);
    setOperatorsError("");

    try {
      const response = await fetch(`/api/apps/${appId}/irc/operators/${encodeURIComponent(username)}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to remove operator"));
      }

      const result = (await response.json()) as IrcOperatorsResponse;
      setOperators(result.operators);
    } catch (error) {
      setOperatorsError(error instanceof Error ? error.message : "Unable to remove operator");
    } finally {
      setRemovingUsername(null);
    }
  };

  const saveMotd = async () => {
    setMotdSaving(true);
    setMotdError("");
    setMotdSaved(false);

    try {
      const response = await fetch(`/api/apps/${appId}/irc/motd`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: motd })
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to save the MOTD"));
      }

      setMotdSaved(true);
    } catch (error) {
      setMotdError(error instanceof Error ? error.message : "Unable to save the MOTD");
    } finally {
      setMotdSaving(false);
    }
  };

  if (!containerRunning) {
    return (
      <div className="app-detail-tab-panel">
        <div className="empty-state">
          The container is not running, so its IRC settings can't be changed right now.
        </div>
      </div>
    );
  }

  return (
    <div className="app-detail-tab-panel">
      <div className="env-scope-heading">
        <h3>Operators</h3>
      </div>
      <p className="section-description">
        Admins and moderators for this server. Changes apply immediately via a config
        rehash — no restart, and connected users stay connected.
      </p>

      {operatorsError && <div className="error-banner">{operatorsError}</div>}

      {operatorsLoading ? (
        <div className="empty-state">Loading operators...</div>
      ) : operators && operators.length > 0 ? (
        <div className="wizard-row-list">
          {operators.map((operator) => (
            <div className="wizard-row" key={operator.username}>
              <div className="wizard-row-fields">
                <span className="stat-card-value" style={{ fontSize: "1rem" }}>
                  {operator.username}
                </span>
                <span className="text-faint">
                  {operator.knownRole ? ROLE_LABELS[operator.role] : "Custom role (set outside this panel)"}
                </span>
              </div>
              <div className="wizard-row-actions">
                <button
                  className="danger-button compact"
                  type="button"
                  disabled={removingUsername === operator.username}
                  onClick={() => void removeOperator(operator.username)}
                >
                  {removingUsername === operator.username ? "Removing..." : "Remove"}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">No operators configured yet.</div>
      )}

      <form className="wizard-row-list" onSubmit={addOperator} style={{ marginTop: 16 }}>
        <div className="wizard-row">
          <div className="wizard-row-fields">
            <label>
              <span>Username</span>
              <input
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)}
                placeholder="alice"
                required
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="At least 8 characters"
                minLength={8}
                required
              />
            </label>
            <label>
              <span>Role</span>
              <select value={newRole} onChange={(event) => setNewRole(event.target.value as IrcOperatorRole)}>
                <option value="moderator">Moderator</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
          <div className="wizard-row-actions">
            <button className="primary-button compact" type="submit" disabled={addingOperator}>
              {addingOperator ? "Adding..." : "Add Operator"}
            </button>
          </div>
        </div>
      </form>

      {addError && <div className="error-banner">{addError}</div>}

      <div className="env-scope-heading" style={{ marginTop: 28 }}>
        <h3>Message of the Day</h3>
        <button className="secondary-button compact" type="button" onClick={() => void saveMotd()} disabled={motdSaving}>
          {motdSaving ? "Saving..." : "Save MOTD"}
        </button>
      </div>
      <p className="section-description">
        Shown to everyone when they connect. Also applied via a config rehash — no restart needed.
      </p>

      {motdError && <div className="error-banner">{motdError}</div>}
      {motdSaved && <div className="notice-banner">MOTD saved.</div>}

      {motdLoading ? (
        <div className="empty-state">Loading MOTD...</div>
      ) : (
        <textarea
          className="bulk-env-textarea"
          value={motd}
          onChange={(event) => {
            setMotd(event.target.value);
            setMotdSaved(false);
          }}
          rows={8}
          placeholder="Welcome to Quipora IRC!"
        />
      )}
    </div>
  );
}
