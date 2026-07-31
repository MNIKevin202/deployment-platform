import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  BotConfig,
  BotConfigResponse,
  BotModerationAction,
  BotRegisterNickResponse,
  BotStatus,
  BotStatusResponse
} from "../types/api";
import Tabs from "./Tabs";

type BotSubTab = "identity" | "commands" | "moderation" | "welcome";

interface IrcBotSettingsPanelProps {
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

function wordsToLines(words: string[]): string {
  return words.join("\n");
}

function linesToWords(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface CustomCommandRow {
  key: string;
  value: string;
}

function commandsToRows(commands: Record<string, string>): CustomCommandRow[] {
  return Object.entries(commands).map(([key, value]) => ({ key, value }));
}

function rowsToCommands(rows: CustomCommandRow[]): Record<string, string> {
  const commands: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) {
      commands[key] = row.value;
    }
  }
  return commands;
}

export default function IrcBotSettingsPanel({ appId, containerRunning }: IrcBotSettingsPanelProps) {
  const [subTab, setSubTab] = useState<BotSubTab>("identity");

  const [status, setStatus] = useState<BotStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState("");

  const [config, setConfig] = useState<BotConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState("");
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);

  const [commandRows, setCommandRows] = useState<CustomCommandRow[]>([]);
  const [bannedWordsText, setBannedWordsText] = useState("");

  const [registerPassword, setRegisterPassword] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registerResult, setRegisterResult] = useState<BotRegisterNickResponse | null>(null);
  const [registerError, setRegisterError] = useState("");

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError("");

    try {
      const response = await fetch(`/api/apps/${appId}/bot/status`);
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load bot status"));
      }
      const result = (await response.json()) as BotStatusResponse;
      setStatus(result.status);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "Unable to load bot status");
    } finally {
      setStatusLoading(false);
    }
  }, [appId]);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError("");

    try {
      const response = await fetch(`/api/apps/${appId}/bot/config`);
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load bot settings"));
      }
      const result = (await response.json()) as BotConfigResponse;
      setConfig(result.config);
      setCommandRows(commandsToRows(result.config.botCommands));
      setBannedWordsText(wordsToLines(result.config.bannedWords));
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : "Unable to load bot settings");
    } finally {
      setConfigLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    if (!containerRunning) {
      setStatusLoading(false);
      setConfigLoading(false);
      return;
    }
    void loadStatus();
    void loadConfig();
  }, [containerRunning, loadStatus, loadConfig]);

  const saveConfig = async (patch: Partial<BotConfig>) => {
    setConfigSaving(true);
    setConfigError("");
    setConfigSaved(false);

    try {
      const response = await fetch(`/api/apps/${appId}/bot/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to save bot settings"));
      }

      const result = (await response.json()) as BotConfigResponse;
      setConfig(result.config);
      setCommandRows(commandsToRows(result.config.botCommands));
      setBannedWordsText(wordsToLines(result.config.bannedWords));
      setConfigSaved(true);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : "Unable to save bot settings");
    } finally {
      setConfigSaving(false);
    }
  };

  const registerNick = async (event: React.FormEvent) => {
    event.preventDefault();
    setRegistering(true);
    setRegisterError("");
    setRegisterResult(null);

    try {
      const response = await fetch(`/api/apps/${appId}/bot/register-nick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registerEmail.trim() ? { password: registerPassword, email: registerEmail.trim() } : { password: registerPassword })
      });

      const result = (await response.json()) as BotRegisterNickResponse;
      setRegisterResult(result);
      if (result.ok) {
        setRegisterPassword("");
        void loadStatus();
      }
    } catch (error) {
      setRegisterError(error instanceof Error ? error.message : "Unable to register the nickname");
    } finally {
      setRegistering(false);
    }
  };

  if (!containerRunning) {
    return (
      <div className="app-detail-tab-panel">
        <div className="empty-state">The bot's container is not running, so its settings can't be changed right now.</div>
      </div>
    );
  }

  return (
    <div className="app-detail-tab-panel">
      <Tabs
        items={[
          { key: "identity", label: "Identity" },
          { key: "commands", label: "Commands" },
          { key: "moderation", label: "Moderation" },
          { key: "welcome", label: "Welcome" }
        ]}
        active={subTab}
        onChange={(key) => setSubTab(key as BotSubTab)}
      />

      {subTab === "identity" && (
        <div className="app-detail-tab-panel" style={{ padding: 0 }}>
          <div className="env-scope-heading">
            <h3>Identity</h3>
          </div>
          <p className="section-description">
            Register the bot's current nickname with NickServ so nobody else can take it.
          </p>

          {statusError && <div className="error-banner">{statusError}</div>}

          {statusLoading ? (
            <div className="empty-state">Loading status...</div>
          ) : status ? (
            <div className="wizard-row-list">
              <div className="wizard-row">
                <div className="wizard-row-fields">
                  <span className="stat-card-value" style={{ fontSize: "1rem" }}>
                    {status.nick}
                  </span>
                  <span className="text-faint">
                    {status.connected ? "Connected" : "Not connected"} ·{" "}
                    {status.nickRegistered ? "Registered" : "Not registered"} · Joined{" "}
                    {status.joinedChannels.length} channel{status.joinedChannels.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          <form className="wizard-row-list" onSubmit={registerNick} style={{ marginTop: 16 }}>
            <div className="wizard-row">
              <div className="wizard-row-fields">
                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    value={registerPassword}
                    onChange={(event) => setRegisterPassword(event.target.value)}
                    placeholder="A new NickServ account password"
                    required
                  />
                </label>
                <label>
                  <span>Email (optional)</span>
                  <input
                    type="email"
                    value={registerEmail}
                    onChange={(event) => setRegisterEmail(event.target.value)}
                    placeholder="Not required — email verification is off"
                  />
                </label>
              </div>
              <div className="wizard-row-actions">
                <button className="primary-button compact" type="submit" disabled={registering || !status?.connected}>
                  {registering ? "Registering..." : "Register Nickname"}
                </button>
              </div>
            </div>
          </form>

          {registerError && <div className="error-banner">{registerError}</div>}
          {registerResult && (
            <div className={registerResult.ok ? "notice-banner" : "error-banner"}>{registerResult.message}</div>
          )}
        </div>
      )}

      {subTab === "commands" && config && (
        <div className="app-detail-tab-panel" style={{ padding: 0 }}>
          <div className="env-scope-heading">
            <h3>Commands</h3>
            <button
              className="secondary-button compact"
              type="button"
              disabled={configSaving}
              onClick={() =>
                void saveConfig({
                  commandPrefix: config.commandPrefix,
                  rulesText: config.rulesText,
                  botCommands: rowsToCommands(commandRows)
                })
              }
            >
              {configSaving ? "Saving..." : "Save Commands"}
            </button>
          </div>
          <p className="section-description">Applies immediately — no restart needed.</p>

          {configError && <div className="error-banner">{configError}</div>}
          {configSaved && <div className="notice-banner">Saved.</div>}

          {configLoading ? (
            <div className="empty-state">Loading...</div>
          ) : (
            <div className="wizard-form-grid">
              <label>
                <span>Command prefix</span>
                <input
                  value={config.commandPrefix}
                  onChange={(event) => {
                    setConfig({ ...config, commandPrefix: event.target.value });
                    setConfigSaved(false);
                  }}
                  placeholder="!"
                />
              </label>

              <label>
                <span>Rules text (shown by the built-in !rules command)</span>
                <textarea
                  className="bulk-env-textarea"
                  value={config.rulesText}
                  onChange={(event) => {
                    setConfig({ ...config, rulesText: event.target.value });
                    setConfigSaved(false);
                  }}
                  rows={4}
                  placeholder="Be respectful. No spam. Have fun."
                />
              </label>

              <div>
                <span>Custom commands</span>
                <div className="wizard-row-list" style={{ marginTop: 8 }}>
                  {commandRows.map((row, index) => (
                    <div className="wizard-row" key={index}>
                      <div className="wizard-row-fields">
                        <input
                          value={row.key}
                          onChange={(event) => {
                            const next = [...commandRows];
                            next[index] = { ...row, key: event.target.value };
                            setCommandRows(next);
                            setConfigSaved(false);
                          }}
                          placeholder="!discord"
                        />
                        <input
                          value={row.value}
                          onChange={(event) => {
                            const next = [...commandRows];
                            next[index] = { ...row, value: event.target.value };
                            setCommandRows(next);
                            setConfigSaved(false);
                          }}
                          placeholder="Reply text"
                        />
                      </div>
                      <div className="wizard-row-actions">
                        <button
                          className="danger-button compact"
                          type="button"
                          onClick={() => {
                            setCommandRows(commandRows.filter((_, i) => i !== index));
                            setConfigSaved(false);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={() => setCommandRows([...commandRows, { key: "", value: "" }])}
                  >
                    Add Command
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {subTab === "moderation" && config && (
        <div className="app-detail-tab-panel" style={{ padding: 0 }}>
          <div className="env-scope-heading">
            <h3>Moderation</h3>
            <button
              className="secondary-button compact"
              type="button"
              disabled={configSaving}
              onClick={() =>
                void saveConfig({
                  bannedWords: linesToWords(bannedWordsText),
                  moderationAction: config.moderationAction
                })
              }
            >
              {configSaving ? "Saving..." : "Save Moderation"}
            </button>
          </div>
          <p className="section-description">Applies immediately — no restart needed.</p>

          {configError && <div className="error-banner">{configError}</div>}
          {configSaved && <div className="notice-banner">Saved.</div>}

          {configLoading ? (
            <div className="empty-state">Loading...</div>
          ) : (
            <div className="wizard-form-grid">
              <label>
                <span>Banned words</span>
                <textarea
                  className="bulk-env-textarea"
                  value={bannedWordsText}
                  onChange={(event) => {
                    setBannedWordsText(event.target.value);
                    setConfigSaved(false);
                  }}
                  rows={4}
                  placeholder={"one per line"}
                />
                <small className="text-faint">Case-insensitive substring match.</small>
              </label>

              <fieldset className="wizard-fieldset">
                <legend>Action when a banned word is used</legend>
                <label className="checkbox-field">
                  <input
                    type="radio"
                    name="moderationAction"
                    checked={config.moderationAction === "warn"}
                    onChange={() => {
                      setConfig({ ...config, moderationAction: "warn" as BotModerationAction });
                      setConfigSaved(false);
                    }}
                  />
                  <span>Warn only</span>
                </label>
                <label className="checkbox-field">
                  <input
                    type="radio"
                    name="moderationAction"
                    checked={config.moderationAction === "kick"}
                    onChange={() => {
                      setConfig({ ...config, moderationAction: "kick" as BotModerationAction });
                      setConfigSaved(false);
                    }}
                  />
                  <span>Warn and kick</span>
                </label>
              </fieldset>
            </div>
          )}
        </div>
      )}

      {subTab === "welcome" && config && (
        <div className="app-detail-tab-panel" style={{ padding: 0 }}>
          <div className="env-scope-heading">
            <h3>Welcome message</h3>
            <button
              className="secondary-button compact"
              type="button"
              disabled={configSaving}
              onClick={() => void saveConfig({ welcomeMessageTemplate: config.welcomeMessageTemplate })}
            >
              {configSaving ? "Saving..." : "Save Welcome Message"}
            </button>
          </div>
          <p className="section-description">
            Sent to a channel whenever someone new joins. Leave blank to disable. Applies immediately.
          </p>

          {configError && <div className="error-banner">{configError}</div>}
          {configSaved && <div className="notice-banner">Saved.</div>}

          {configLoading ? (
            <div className="empty-state">Loading...</div>
          ) : (
            <label>
              <span>Message template</span>
              <textarea
                className="bulk-env-textarea"
                value={config.welcomeMessageTemplate}
                onChange={(event) => {
                  setConfig({ ...config, welcomeMessageTemplate: event.target.value });
                  setConfigSaved(false);
                }}
                rows={3}
                placeholder="Welcome to the channel, {nick}!"
              />
              <small className="text-faint">{"{nick}"} is replaced with the joining user's nickname.</small>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
