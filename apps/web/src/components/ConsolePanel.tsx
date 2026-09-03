import { useCallback, useEffect, useRef, useState } from "react";

interface ConsolePanelProps {
  appId: number;
  /** Trimmed embed for the App Detail hero: minimal toolbar, shorter log area. */
  compact?: boolean;
  /** In compact mode, renders an "Open full console" affordance. */
  onOpenFull?: () => void;
}

/** Cap on client-side retained lines so a chatty app can't grow memory without bound. */
const MAX_LINES = 5000;
const TAIL_OPTIONS = [100, 200, 500, 1000];

type ConnectionStatus = "connecting" | "live" | "reconnecting" | "stopped";
type CopyState = "idle" | "copied" | "failed";

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  stopped: "Stopped"
};

const STATUS_TONES: Record<ConnectionStatus, "positive" | "warning" | "neutral"> = {
  connecting: "warning",
  live: "positive",
  reconnecting: "warning",
  stopped: "neutral"
};

function formatConsoleTime(value: Date | null): string {
  return value ? value.toLocaleTimeString() : "Waiting";
}

export default function ConsolePanel({ appId, compact = false, onOpenFull }: ConsolePanelProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [notice, setNotice] = useState("");
  const [tail, setTail] = useState(200);
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [paused, setPaused] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [lastLineAt, setLastLineAt] = useState<Date | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the view is pinned to the bottom (auto-follow). Unpins when the
  // user scrolls up to read history, re-pins when they scroll back down.
  const pinnedRef = useRef(true);

  const appendLines = useCallback((incoming: string[]) => {
    setLines((current) => {
      const next = current.concat(incoming);
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  useEffect(() => {
    if (paused) {
      setStatus("stopped");
      return;
    }

    // No SSE support (e.g. a non-browser/test environment) — render the panel
    // idle rather than throwing on `new EventSource`.
    if (typeof EventSource === "undefined") {
      setStatus("stopped");
      return;
    }

    setLines([]);
    setNotice("");
    setLastLineAt(null);
    setCopyState("idle");
    setStatus("connecting");

    const params = new URLSearchParams({
      tail: String(tail),
      timestamps: String(timestamps)
    });
    const source = new EventSource(`/api/apps/${appId}/logs/stream?${params.toString()}`);
    let ended = false;

    source.onopen = () => setStatus("live");

    source.addEventListener("line", (event) => {
      try {
        const { line } = JSON.parse((event as MessageEvent).data) as { line: string };
        appendLines([line]);
        setLastLineAt(new Date());
      } catch {
        // Ignore a malformed frame rather than tearing down the stream.
      }
    });

    source.addEventListener("notice", (event) => {
      try {
        const { message } = JSON.parse((event as MessageEvent).data) as { message: string };
        setNotice(message);
      } catch {
        // Ignore malformed notice payloads.
      }
    });

    source.addEventListener("end", () => {
      ended = true;
      setStatus("stopped");
      source.close();
    });

    // A transient drop: the browser's EventSource reconnects on its own, so
    // just reflect the state. A deliberate server-side end (above) closes
    // the socket so no reconnect is attempted.
    source.onerror = () => {
      if (!ended) {
        setStatus("reconnecting");
      }
    };

    return () => source.close();
  }, [appId, tail, timestamps, paused, reconnectNonce, appendLines]);

  // Auto-follow: keep the newest line in view while pinned to the bottom.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedRef.current = distanceFromBottom < 40;
  };

  const reconnect = () => {
    pinnedRef.current = true;
    setPaused(false);
    setReconnectNonce((value) => value + 1);
  };

  const clear = () => {
    setLines([]);
    setLastLineAt(null);
    setCopyState("idle");
  };

  const copyConsole = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 3000);
    }
  };

  const lineCountLabel = `${lines.length.toLocaleString()} ${lines.length === 1 ? "line" : "lines"}`;
  const retainedLabel =
    lines.length >= MAX_LINES ? `Retaining newest ${MAX_LINES.toLocaleString()} lines` : "Retaining full buffer";

  return (
    <div className={compact ? "console-compact" : "app-detail-tab-panel"}>
      <div className="logs-toolbar">
        <div className="logs-toolbar-group">
          {compact && <span className="console-compact-title">Console</span>}
          <span className={`status-badge compact ${STATUS_TONES[status]}`}>
            <span className="console-status-dot" aria-hidden="true" /> {STATUS_LABELS[status]}
          </span>

          {!compact && (
            <>
              <label className="logs-toolbar-field">
                <span>Tail</span>
                <select
                  className="wizard-select"
                  value={tail}
                  onChange={(event) => setTail(Number(event.target.value))}
                >
                  {TAIL_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={timestamps}
                  onChange={(event) => setTimestamps(event.target.checked)}
                />
                <span>Timestamps</span>
              </label>

              <label className="checkbox-field">
                <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
                <span>Wrap lines</span>
              </label>
            </>
          )}
        </div>

        <div className="logs-toolbar-group">
          {compact && onOpenFull && (
            <button className="secondary-button compact" type="button" onClick={onOpenFull}>
              Open full console →
            </button>
          )}
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => void copyConsole()}
            disabled={lines.length === 0}
          >
            {copyState === "copied" ? "Copied!" : copyState === "failed" ? "Copy failed" : "Copy console"}
          </button>
          {!compact && (
            <button className="secondary-button compact" type="button" onClick={clear}>
              Clear
            </button>
          )}
          {paused ? (
            <button className="primary-button compact" type="button" onClick={() => setPaused(false)}>
              Resume
            </button>
          ) : status === "stopped" ? (
            <button className="primary-button compact" type="button" onClick={reconnect}>
              Reconnect
            </button>
          ) : (
            <button className="secondary-button compact" type="button" onClick={() => setPaused(true)}>
              Pause
            </button>
          )}
        </div>
      </div>

      <div className="console-live-detail" aria-live="polite">
        <span>{lineCountLabel}</span>
        <span>{retainedLabel}</span>
        <span>Last output: {formatConsoleTime(lastLineAt)}</span>
        <span>Mode: {paused ? "Paused" : "Following live output"}</span>
      </div>

      {notice && <div className="warning-banner">{notice}</div>}

      <div className="logs-modal logs-inline console-output" ref={scrollRef} onScroll={handleScroll}>
        {lines.length === 0 ? (
          <p className="logs-state">
            {status === "stopped"
              ? "The stream is stopped. Start the app or reconnect to follow its output."
              : "Waiting for output..."}
          </p>
        ) : (
          <pre className={wrap ? undefined : "logs-nowrap"}>{lines.join("\n")}</pre>
        )}
      </div>
    </div>
  );
}
