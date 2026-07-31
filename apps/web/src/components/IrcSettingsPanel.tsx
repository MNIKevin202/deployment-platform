import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  IrcGeneralSettings,
  IrcMotdResponse,
  IrcOperator,
  IrcOperatorRole,
  IrcOperatorsResponse,
  IrcSettingsResponse
} from "../types/api";
import Tabs from "./Tabs";
import ChannelsPanel from "./ChannelsPanel";

type IrcSubTab = "general" | "operators" | "motd" | "channels";

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

function channelsToLines(channels: string[]): string {
  return channels.join("\n");
}

function linesToChannels(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export default function IrcSettingsPanel({ appId, containerRunning }: IrcSettingsPanelProps) {
  const [subTab, setSubTab] = useState<IrcSubTab>("general");
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

  const [settings, setSettings] = useState<IrcGeneralSettings | null>(null);
  const [autoJoinText, setAutoJoinText] = useState("");
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);

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

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsError("");

    try {
      const response = await fetch(`/api/apps/${appId}/irc/settings`);
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load settings"));
      }
      const result = (await response.json()) as IrcSettingsResponse;
      setSettings(result.settings);
      setAutoJoinText(channelsToLines(result.settings.autoJoinChannels));
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Unable to load settings");
    } finally {
      setSettingsLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    if (!containerRunning) {
      setOperatorsLoading(false);
      setMotdLoading(false);
      setSettingsLoading(false);
      return;
    }
    void loadOperators();
    void loadMotd();
    void loadSettings();
  }, [containerRunning, loadOperators, loadMotd, loadSettings]);

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

  const updateSettingsField = <K extends keyof IrcGeneralSettings>(key: K, value: IrcGeneralSettings[K]) => {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
    setSettingsSaved(false);
  };

  const saveSettings = async () => {
    if (!settings) {
      return;
    }

    setSettingsSaving(true);
    setSettingsError("");
    setSettingsSaved(false);

    const payload: IrcGeneralSettings = {
      ...settings,
      autoJoinChannels: linesToChannels(autoJoinText)
    };

    try {
      const response = await fetch(`/api/apps/${appId}/irc/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to save settings"));
      }

      const result = (await response.json()) as IrcSettingsResponse;
      setSettings(result.settings);
      setAutoJoinText(channelsToLines(result.settings.autoJoinChannels));
      setSettingsSaved(true);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Unable to save settings");
    } finally {
      setSettingsSaving(false);
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
      <Tabs
        items={[
          { key: "general", label: "General" },
          { key: "operators", label: "Operators" },
          { key: "motd", label: "MOTD" },
          { key: "channels", label: "Channels" }
        ]}
        active={subTab}
        onChange={(key) => setSubTab(key as IrcSubTab)}
      />

      {subTab === "general" && (
        <div className="app-detail-tab-panel" style={{ padding: 0 }}>
          <div className="env-scope-heading">
            <h3>General</h3>
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => void saveSettings()}
              disabled={settingsSaving || !settings}
            >
              {settingsSaving ? "Saving..." : "Save Settings"}
            </button>
          </div>
          <p className="section-description">
            Server-wide behavior. Applied via a config rehash — no restart, and connected users stay
            connected.
          </p>

          {settingsError && <div className="error-banner">{settingsError}</div>}
          {settingsSaved && <div className="notice-banner">Settings saved.</div>}

          {settingsLoading ? (
        <div className="empty-state">Loading settings...</div>
      ) : settings ? (
        <div className="wizard-form-grid">
          <label>
            <span>Network name</span>
            <input
              value={settings.networkName}
              onChange={(event) => updateSettingsField("networkName", event.target.value)}
              pattern="[A-Za-z0-9_.\-]+"
              title="Letters, digits, '.', '_', and '-' only — no spaces"
            />
            <small className="text-faint">
              Sent as a raw IRC protocol token — letters, digits, '.', '_', and '-' only, no spaces.
            </small>
          </label>

          <label>
            <span>Auto-join channels</span>
            <textarea
              className="bulk-env-textarea"
              value={autoJoinText}
              onChange={(event) => {
                setAutoJoinText(event.target.value);
                setSettingsSaved(false);
              }}
              rows={3}
              placeholder={"#lobby\n#general"}
            />
            <small className="text-faint">
              One channel per line. Everyone joins these automatically on connect.
            </small>
          </label>

          <label>
            <span>Default channel modes</span>
            <input
              value={settings.defaultChannelModes}
              onChange={(event) => updateSettingsField("defaultChannelModes", event.target.value)}
              placeholder="+ntC"
            />
            <small className="text-faint">Applied to newly created channels.</small>
          </label>

          <label>
            <span>Max channels per client</span>
            <input
              type="number"
              min={1}
              value={settings.maxChannelsPerClient}
              onChange={(event) => updateSettingsField("maxChannelsPerClient", Number(event.target.value))}
            />
          </label>

          <fieldset className="wizard-fieldset">
            <legend>Channel registration</legend>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={settings.channelRegistrationEnabled}
                onChange={(event) => updateSettingsField("channelRegistrationEnabled", event.target.checked)}
              />
              <span>Enabled</span>
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={settings.channelRegistrationOperatorOnly}
                onChange={(event) =>
                  updateSettingsField("channelRegistrationOperatorOnly", event.target.checked)
                }
              />
              <span>Operators only</span>
            </label>
            <label>
              <span>Max channels per account</span>
              <input
                type="number"
                min={1}
                value={settings.maxChannelsPerAccount}
                onChange={(event) => updateSettingsField("maxChannelsPerAccount", Number(event.target.value))}
              />
            </label>
          </fieldset>

          <fieldset className="wizard-fieldset">
            <legend>Account registration</legend>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={settings.accountRegistrationEnabled}
                onChange={(event) => updateSettingsField("accountRegistrationEnabled", event.target.checked)}
              />
              <span>Enabled</span>
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={settings.allowRegistrationBeforeConnect}
                onChange={(event) =>
                  updateSettingsField("allowRegistrationBeforeConnect", event.target.checked)
                }
              />
              <span>Allow registering before connecting (SASL/NickServ REGISTER pre-auth)</span>
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={settings.emailVerificationEnabled}
                onChange={(event) => updateSettingsField("emailVerificationEnabled", event.target.checked)}
              />
              <span>Require email verification</span>
            </label>
          </fieldset>
        </div>
      ) : null}
        </div>
      )}

      {subTab === "operators" && (
        <div className="app-detail-tab-panel" style={{ padding: 0 }}>
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
        </div>
      )}

      {subTab === "motd" && (
        <div className="app-detail-tab-panel" style={{ padding: 0 }}>
      <div className="env-scope-heading">
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
      )}

      {subTab === "channels" && <ChannelsPanel appId={appId} containerRunning={containerRunning} />}
    </div>
  );
}
