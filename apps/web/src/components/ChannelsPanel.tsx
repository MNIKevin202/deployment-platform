import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  IrcChannelActionResponse,
  IrcChannelsResponse,
  IrcRegisteredChannel
} from "../types/api";

interface ChannelsPanelProps {
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

function formatDate(value: string | null): string {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function ChannelsPanel({ appId, containerRunning }: ChannelsPanelProps) {
  const [channels, setChannels] = useState<IrcRegisteredChannel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState("");
  const [busyAction, setBusyAction] = useState<{ channel: string; kind: "unregister" | "transfer" } | null>(
    null
  );
  const [actionError, setActionError] = useState("");
  const [confirmUnregister, setConfirmUnregister] = useState<string | null>(null);

  const loadChannels = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`/api/apps/${appId}/irc/channels`);
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load channels"));
      }
      const result = (await response.json()) as IrcChannelsResponse;
      setChannels(result.channels);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load channels");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    if (!containerRunning) {
      setLoading(false);
      return;
    }
    void loadChannels();
  }, [containerRunning, loadChannels]);

  const unregisterChannel = async (channel: string) => {
    setBusyAction({ channel, kind: "unregister" });
    setActionError("");

    try {
      const response = await fetch(`/api/apps/${appId}/irc/channels/${encodeURIComponent(channel)}/unregister`, {
        method: "POST"
      });

      const result = (await response.json()) as IrcChannelActionResponse;
      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to unregister this channel");
      }

      setConfirmUnregister(null);
      await loadChannels();
    } catch (actionErr) {
      setActionError(actionErr instanceof Error ? actionErr.message : "Unable to unregister this channel");
    } finally {
      setBusyAction(null);
    }
  };

  const transferChannel = async (channel: string) => {
    setBusyAction({ channel, kind: "transfer" });
    setActionError("");

    try {
      const response = await fetch(`/api/apps/${appId}/irc/channels/${encodeURIComponent(channel)}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newFounder: transferTarget.trim() })
      });

      const result = (await response.json()) as IrcChannelActionResponse;
      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to transfer this channel");
      }

      setTransferTarget("");
      setExpanded(null);
      await loadChannels();
    } catch (actionErr) {
      setActionError(actionErr instanceof Error ? actionErr.message : "Unable to transfer this channel");
    } finally {
      setBusyAction(null);
    }
  };

  if (!containerRunning) {
    return (
      <div className="app-detail-tab-panel">
        <div className="empty-state">
          The container is not running, so channels can't be listed right now.
        </div>
      </div>
    );
  }

  return (
    <div className="app-detail-tab-panel">
      <div className="env-scope-heading">
        <h3>Registered Channels</h3>
        <button className="secondary-button compact" type="button" onClick={() => void loadChannels()} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      <p className="section-description">
        Every channel currently registered with ChanServ, and who founded it. Listing briefly
        creates a temporary operator account to query the server, then removes it — this can take
        a few seconds.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      {loading && !channels ? (
        <div className="empty-state">Loading registered channels...</div>
      ) : channels && channels.length > 0 ? (
        <div className="wizard-row-list">
          {channels.map((channel) => (
            <div className="wizard-row" key={channel.name} style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                <div className="wizard-row-fields">
                  <span className="stat-card-value" style={{ fontSize: "1rem" }}>
                    {channel.name}
                  </span>
                  <span className="text-faint">
                    Founder: {channel.founder ?? "unknown"} · Registered: {formatDate(channel.registeredAt)}
                  </span>
                </div>
                <div className="wizard-row-actions">
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={() => {
                      setExpanded(expanded === channel.name ? null : channel.name);
                      setTransferTarget("");
                      setActionError("");
                    }}
                  >
                    {expanded === channel.name ? "Close" : "Manage"}
                  </button>
                </div>
              </div>

              {expanded === channel.name && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--color-border-soft)" }}>
                  <div className="wizard-row-fields">
                    <label>
                      <span>Transfer to (account name)</span>
                      <input
                        value={transferTarget}
                        onChange={(event) => setTransferTarget(event.target.value)}
                        placeholder="newowner"
                      />
                    </label>
                  </div>
                  <div className="wizard-row-actions" style={{ marginTop: 8, gap: 8 }}>
                    <button
                      className="primary-button compact"
                      type="button"
                      disabled={!transferTarget.trim() || busyAction !== null}
                      onClick={() => void transferChannel(channel.name)}
                    >
                      {busyAction?.channel === channel.name && busyAction.kind === "transfer"
                        ? "Transferring..."
                        : "Transfer Ownership"}
                    </button>

                    {confirmUnregister === channel.name ? (
                      <>
                        <span className="text-faint">Unregister {channel.name}? This can't be undone.</span>
                        <button
                          className="danger-button compact"
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => void unregisterChannel(channel.name)}
                        >
                          {busyAction?.channel === channel.name && busyAction.kind === "unregister"
                            ? "Unregistering..."
                            : "Confirm Unregister"}
                        </button>
                        <button
                          className="secondary-button compact"
                          type="button"
                          onClick={() => setConfirmUnregister(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="danger-button compact"
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => setConfirmUnregister(channel.name)}
                      >
                        Unregister
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">No channels are registered yet.</div>
      )}
    </div>
  );
}
