import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  IrcBlockedChannelsResponse,
  IrcChannelActionResponse,
  IrcChannelDetail,
  IrcChannelDetailResponse,
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

  const [blockedChannels, setBlockedChannels] = useState<string[] | null>(null);
  const [blockedError, setBlockedError] = useState("");
  const [blockBusy, setBlockBusy] = useState<string | null>(null);
  const [confirmBlock, setConfirmBlock] = useState<string | null>(null);

  const [detailChannel, setDetailChannel] = useState<string | null>(null);
  const [detail, setDetail] = useState<IrcChannelDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [memberActionError, setMemberActionError] = useState("");
  const [memberBusy, setMemberBusy] = useState<{ nick: string; kind: string } | null>(null);
  const [transferTarget, setTransferTarget] = useState("");
  const [confirmUnregister, setConfirmUnregister] = useState(false);

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

  const loadBlockedChannels = useCallback(async () => {
    setBlockedError("");
    try {
      const response = await fetch(`/api/apps/${appId}/irc/blocked-channels`);
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load blocked channels"));
      }
      const result = (await response.json()) as IrcBlockedChannelsResponse;
      setBlockedChannels(result.channels);
    } catch (loadError) {
      setBlockedError(loadError instanceof Error ? loadError.message : "Unable to load blocked channels");
      setBlockedChannels([]);
    }
  }, [appId]);

  useEffect(() => {
    if (!containerRunning) {
      setLoading(false);
      return;
    }
    void loadChannels();
    void loadBlockedChannels();
  }, [containerRunning, loadChannels, loadBlockedChannels]);

  const loadDetail = useCallback(
    async (channel: string) => {
      setDetailLoading(true);
      setDetailError("");
      setMemberActionError("");

      try {
        const response = await fetch(`/api/apps/${appId}/irc/channels/${encodeURIComponent(channel)}`);
        if (!response.ok) {
          throw new Error(await readApiError(response, "Unable to load channel details"));
        }
        const result = (await response.json()) as IrcChannelDetailResponse;
        setDetail(result.channel);
      } catch (loadError) {
        setDetailError(loadError instanceof Error ? loadError.message : "Unable to load channel details");
      } finally {
        setDetailLoading(false);
      }
    },
    [appId]
  );

  const openDetail = (channel: string) => {
    setDetailChannel(channel);
    setDetail(null);
    setTransferTarget("");
    setConfirmUnregister(false);
    void loadDetail(channel);
  };

  const closeDetail = () => {
    setDetailChannel(null);
    setDetail(null);
  };

  const runMemberAction = async (kind: "kick" | "ban" | "op" | "deop", nick: string) => {
    if (!detailChannel) {
      return;
    }
    setMemberBusy({ nick, kind });
    setMemberActionError("");

    const path = kind === "op" || kind === "deop" ? "op" : kind;
    const body = kind === "op" || kind === "deop" ? { nick, grant: kind === "op" } : { nick };

    try {
      const response = await fetch(
        `/api/apps/${appId}/irc/channels/${encodeURIComponent(detailChannel)}/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }
      );
      const result = (await response.json()) as IrcChannelActionResponse;
      if (!response.ok || !result.success) {
        throw new Error(result.message || `Unable to ${kind} ${nick}`);
      }
      await loadDetail(detailChannel);
      void loadChannels();
    } catch (actionErr) {
      setMemberActionError(actionErr instanceof Error ? actionErr.message : `Unable to ${kind} ${nick}`);
    } finally {
      setMemberBusy(null);
    }
  };

  const unregisterChannel = async () => {
    if (!detailChannel) {
      return;
    }
    setMemberBusy({ nick: "", kind: "unregister" });
    setMemberActionError("");

    try {
      const response = await fetch(
        `/api/apps/${appId}/irc/channels/${encodeURIComponent(detailChannel)}/unregister`,
        { method: "POST" }
      );
      const result = (await response.json()) as IrcChannelActionResponse;
      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to unregister this channel");
      }
      setConfirmUnregister(false);
      await loadDetail(detailChannel);
      void loadChannels();
    } catch (actionErr) {
      setMemberActionError(actionErr instanceof Error ? actionErr.message : "Unable to unregister this channel");
    } finally {
      setMemberBusy(null);
    }
  };

  const transferChannel = async () => {
    if (!detailChannel || !transferTarget.trim()) {
      return;
    }
    setMemberBusy({ nick: "", kind: "transfer" });
    setMemberActionError("");

    try {
      const response = await fetch(
        `/api/apps/${appId}/irc/channels/${encodeURIComponent(detailChannel)}/transfer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newFounder: transferTarget.trim() })
        }
      );
      const result = (await response.json()) as IrcChannelActionResponse;
      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to transfer this channel");
      }
      setTransferTarget("");
      await loadDetail(detailChannel);
      void loadChannels();
    } catch (actionErr) {
      setMemberActionError(actionErr instanceof Error ? actionErr.message : "Unable to transfer this channel");
    } finally {
      setMemberBusy(null);
    }
  };

  const blockChannel = async (channel: string) => {
    setBlockBusy(channel);
    setBlockedError("");

    try {
      const response = await fetch(`/api/apps/${appId}/irc/channels/${encodeURIComponent(channel)}/block`, {
        method: "POST"
      });
      const result = (await response.json()) as IrcChannelActionResponse;
      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to block this channel");
      }
      setConfirmBlock(null);
      closeDetail();
      await loadChannels();
      await loadBlockedChannels();
    } catch (actionErr) {
      setBlockedError(actionErr instanceof Error ? actionErr.message : "Unable to block this channel");
    } finally {
      setBlockBusy(null);
    }
  };

  const unblockChannel = async (channel: string) => {
    setBlockBusy(channel);
    setBlockedError("");

    try {
      const response = await fetch(`/api/apps/${appId}/irc/channels/${encodeURIComponent(channel)}/block`, {
        method: "DELETE"
      });
      const result = (await response.json()) as IrcChannelActionResponse;
      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to unblock this channel");
      }
      await loadBlockedChannels();
    } catch (actionErr) {
      setBlockedError(actionErr instanceof Error ? actionErr.message : "Unable to unblock this channel");
    } finally {
      setBlockBusy(null);
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
        <h3>Channels</h3>
        <button className="secondary-button compact" type="button" onClick={() => void loadChannels()} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      <p className="section-description">
        Every channel currently active on the server — anyone in it, whether or not it's
        registered with ChanServ. Listing briefly creates a temporary operator account to query
        the server, then removes it — this can take a few seconds.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {loading && !channels ? (
        <div className="empty-state">Loading channels...</div>
      ) : channels && channels.length > 0 ? (
        <div className="container-grid">
          {channels.map((channel) => (
            <article className="container-card" key={channel.name}>
              <div className="container-card-header">
                <div>
                  <div className="title-row">
                    <h3>{channel.name}</h3>
                  </div>
                  <p>
                    {channel.memberCount} member{channel.memberCount === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="card-status">
                  <span className={`status-badge compact ${channel.founder ? "positive" : "neutral"}`}>
                    {channel.founder ? "Registered" : "Not registered"}
                  </span>
                </div>
              </div>

              {channel.founder && (
                <dl className="container-details">
                  <div>
                    <dt>Founder</dt>
                    <dd>{channel.founder}</dd>
                  </div>
                  <div>
                    <dt>Registered</dt>
                    <dd>{formatDate(channel.registeredAt)}</dd>
                  </div>
                </dl>
              )}

              <div className="container-actions card-actions">
                <button className="secondary-button" type="button" onClick={() => openDetail(channel.name)}>
                  Details
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">No channels are currently active on this server.</div>
      )}

      <div className="env-scope-heading" style={{ marginTop: 32 }}>
        <h3>Blocked Channels</h3>
        <button
          className="secondary-button compact"
          type="button"
          onClick={() => void loadBlockedChannels()}
        >
          Refresh
        </button>
      </div>
      <p className="section-description">
        Channels Quipora Bot permanently sits in and instantly kicks anyone who joins. This only
        holds while the bot is running.
      </p>

      {blockedError && <div className="error-banner">{blockedError}</div>}

      {blockedChannels === null ? (
        <div className="empty-state">Loading blocked channels...</div>
      ) : blockedChannels.length > 0 ? (
        <div className="wizard-row-list">
          {blockedChannels.map((channel) => (
            <div className="wizard-row" key={channel}>
              <div className="wizard-row-fields">
                <span className="stat-card-value" style={{ fontSize: "1rem" }}>
                  {channel}
                </span>
              </div>
              <div className="wizard-row-actions">
                <button
                  className="secondary-button compact"
                  type="button"
                  disabled={blockBusy === channel}
                  onClick={() => void unblockChannel(channel)}
                >
                  {blockBusy === channel ? "Unblocking..." : "Unblock"}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">No channels are blocked.</div>
      )}

      {detailChannel && (
        <div className="modal-backdrop" onClick={closeDetail}>
          <section
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="channel-detail-title"
            onClick={(event) => event.stopPropagation()}
            style={{ maxWidth: 560 }}
          >
            <h2 id="channel-detail-title">{detailChannel}</h2>

            {detailError && <div className="error-banner">{detailError}</div>}
            {memberActionError && <div className="error-banner">{memberActionError}</div>}

            {detailLoading && !detail ? (
              <div className="empty-state">Loading...</div>
            ) : detail ? (
              <>
                <dl className="container-details" style={{ marginBottom: 16 }}>
                  <div>
                    <dt>Topic</dt>
                    <dd>{detail.topic || "—"}</dd>
                  </div>
                  <div>
                    <dt>Founder</dt>
                    <dd>{detail.founder ?? "Not registered"}</dd>
                  </div>
                  {detail.founder && (
                    <div>
                      <dt>Registered</dt>
                      <dd>{formatDate(detail.registeredAt)}</dd>
                    </div>
                  )}
                </dl>

                <h3 style={{ fontSize: "0.95rem" }}>
                  Members ({detail.members.length})
                </h3>
                <div className="wizard-row-list" style={{ marginTop: 8, maxHeight: 260, overflowY: "auto" }}>
                  {detail.members.map((member) => (
                    <div className="wizard-row" key={member.nick}>
                      <div className="wizard-row-fields">
                        <span className="stat-card-value" style={{ fontSize: "0.95rem" }}>
                          {member.isOp ? "@" : ""}
                          {member.nick}
                        </span>
                      </div>
                      <div className="wizard-row-actions" style={{ gap: 6 }}>
                        <button
                          className="secondary-button compact"
                          type="button"
                          disabled={memberBusy?.nick === member.nick}
                          onClick={() => void runMemberAction(member.isOp ? "deop" : "op", member.nick)}
                        >
                          {memberBusy?.nick === member.nick && (memberBusy.kind === "op" || memberBusy.kind === "deop")
                            ? "..."
                            : member.isOp
                              ? "De-op"
                              : "Op"}
                        </button>
                        <button
                          className="secondary-button compact"
                          type="button"
                          disabled={memberBusy?.nick === member.nick}
                          onClick={() => void runMemberAction("kick", member.nick)}
                        >
                          {memberBusy?.nick === member.nick && memberBusy.kind === "kick" ? "..." : "Kick"}
                        </button>
                        <button
                          className="danger-button compact"
                          type="button"
                          disabled={memberBusy?.nick === member.nick}
                          onClick={() => void runMemberAction("ban", member.nick)}
                        >
                          {memberBusy?.nick === member.nick && memberBusy.kind === "ban" ? "..." : "Ban"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--color-border-soft)" }}>
                  {detail.founder && (
                    <div className="wizard-row-fields" style={{ marginBottom: 12 }}>
                      <label>
                        <span>Transfer to (account name)</span>
                        <input
                          value={transferTarget}
                          onChange={(event) => setTransferTarget(event.target.value)}
                          placeholder="newowner"
                        />
                      </label>
                    </div>
                  )}

                  <div className="form-actions" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }}>
                    {detail.founder && (
                      <>
                        <button
                          className="secondary-button compact"
                          type="button"
                          disabled={!transferTarget.trim() || memberBusy !== null}
                          onClick={() => void transferChannel()}
                        >
                          {memberBusy?.kind === "transfer" ? "Transferring..." : "Transfer Ownership"}
                        </button>

                        {confirmUnregister ? (
                          <>
                            <span className="text-faint">Unregister? This can't be undone.</span>
                            <button
                              className="danger-button compact"
                              type="button"
                              disabled={memberBusy !== null}
                              onClick={() => void unregisterChannel()}
                            >
                              {memberBusy?.kind === "unregister" ? "Unregistering..." : "Confirm Unregister"}
                            </button>
                            <button
                              className="secondary-button compact"
                              type="button"
                              onClick={() => setConfirmUnregister(false)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            className="danger-button compact"
                            type="button"
                            disabled={memberBusy !== null}
                            onClick={() => setConfirmUnregister(true)}
                          >
                            Unregister
                          </button>
                        )}
                      </>
                    )}

                    {confirmBlock === detailChannel ? (
                      <>
                        <span className="text-faint">
                          Block this channel forever? Everyone will be kicked and nobody can rejoin
                          while the bot is running.
                        </span>
                        <button
                          className="danger-button compact"
                          type="button"
                          disabled={blockBusy === detailChannel}
                          onClick={() => void blockChannel(detailChannel)}
                        >
                          {blockBusy === detailChannel ? "Blocking..." : "Confirm Block"}
                        </button>
                        <button
                          className="secondary-button compact"
                          type="button"
                          onClick={() => setConfirmBlock(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="danger-button compact"
                        type="button"
                        onClick={() => setConfirmBlock(detailChannel)}
                      >
                        Block Channel
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : null}

            <div className="form-actions" style={{ marginTop: 20 }}>
              <button className="secondary-button" type="button" onClick={closeDetail}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
