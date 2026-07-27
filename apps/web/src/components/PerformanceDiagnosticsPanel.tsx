import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  BrowserNavigationTimingPayload,
  BrowserResourceEntryPayload,
  PerformanceDiagnostic,
  PerformanceDiagnosticHistoryResponse,
  PerformanceDiagnosticResponse
} from "../types/api";

interface PerformanceDiagnosticsPanelProps {
  appId: number;
  publicDomain: string | null;
}

// Centralized, easy-to-change thresholds mirroring the backend's
// PERFORMANCE_THRESHOLDS_MS — kept here (not fetched) since they are
// purely a display concern; the backend's own thresholds are what
// actually drive the diagnosis category.
const THRESHOLDS = {
  internalTotal: { good: 150, moderate: 500 },
  publicTtfb: { good: 250, moderate: 800 },
  browserTtfb: { good: 400, moderate: 1000 },
  pageLoad: { good: 2000, moderate: 4000 }
};

type Tier = "good" | "moderate" | "slow" | "unknown";

function tierFor(valueMs: number | null, thresholds: { good: number; moderate: number }): Tier {
  if (valueMs === null || !Number.isFinite(valueMs) || valueMs < 0) return "unknown";
  if (valueMs <= thresholds.good) return "good";
  if (valueMs <= thresholds.moderate) return "moderate";
  return "slow";
}

const TIER_TONE: Record<Tier, "positive" | "warning" | "negative" | "neutral"> = {
  good: "positive",
  moderate: "warning",
  slow: "negative",
  unknown: "neutral"
};

function formatMs(value: number | null): string {
  return value === null ? "Unavailable" : `${Math.round(value)} ms`;
}

function formatBytes(value: number | null): string {
  if (value === null) return "Unavailable";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Best-effort, real (never fabricated) browser-side timing for the
 * app's own public domain. A plain `fetch` from this page to a
 * cross-origin URL always produces a PerformanceResourceTiming entry
 * in *this* document — total duration is always measurable that way,
 * but granular phases (DNS/TCP/TLS/TTFB) are only populated by the
 * browser when the target sends a `Timing-Allow-Origin` header; when
 * it doesn't, those fields come back as "Unavailable" rather than a
 * misleading 0. A genuinely cross-origin app's own subresources
 * (its JS/CSS/fonts/images) are not readable from this page at all —
 * the browser's same-origin policy blocks that without the target's
 * cooperation, so the "resources" submission below only ever includes
 * the one real resource this page can actually observe: the fetch
 * itself. See the deliverable report's Known Limitations for why a
 * full waterfall isn't possible without navigating directly to the app.
 */
async function collectBrowserTiming(
  publicDomain: string
): Promise<{ navigation: BrowserNavigationTimingPayload; resources: BrowserResourceEntryPayload[] }> {
  const url = `https://${publicDomain}/`;
  const start = performance.now();
  let totalMs: number | null = null;
  let statusOk = true;

  try {
    await fetch(url, { mode: "no-cors", cache: "no-store" });
    totalMs = performance.now() - start;
  } catch {
    totalMs = null;
    statusOk = false;
  }

  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  const entry = [...entries].reverse().find((candidate) => candidate.name === url || candidate.name.startsWith(url));
  const hasDetailedTiming = !!entry && entry.responseStart > 0;

  const navigation: BrowserNavigationTimingPayload = {
    dnsMs: hasDetailedTiming ? entry!.domainLookupEnd - entry!.domainLookupStart : null,
    tcpMs: hasDetailedTiming ? entry!.connectEnd - entry!.connectStart : null,
    tlsMs: hasDetailedTiming && entry!.secureConnectionStart > 0 ? entry!.connectEnd - entry!.secureConnectionStart : null,
    requestStartMs: hasDetailedTiming ? entry!.requestStart - entry!.startTime : null,
    ttfbMs: hasDetailedTiming ? entry!.responseStart - entry!.startTime : null,
    downloadMs: hasDetailedTiming ? entry!.responseEnd - entry!.responseStart : null,
    domInteractiveMs: null,
    domContentLoadedMs: null,
    pageLoadMs: totalMs,
    totalNavigationMs: totalMs,
    transferBytes: entry?.transferSize && entry.transferSize > 0 ? entry.transferSize : null,
    encodedBodyBytes: entry?.encodedBodySize && entry.encodedBodySize > 0 ? entry.encodedBodySize : null,
    decodedBodyBytes: entry?.decodedBodySize && entry.decodedBodySize > 0 ? entry.decodedBodySize : null,
    available: totalMs !== null
  };

  const resources: BrowserResourceEntryPayload[] =
    entry && totalMs !== null
      ? [
          {
            url: entry.name,
            initiatorType: entry.initiatorType || "fetch",
            startMs: entry.startTime,
            durationMs: entry.duration,
            transferBytes: entry.transferSize && entry.transferSize > 0 ? entry.transferSize : null,
            statusOk
          }
        ]
      : [];

  return { navigation, resources };
}

export default function PerformanceDiagnosticsPanel({ appId, publicDomain }: PerformanceDiagnosticsPanelProps) {
  const [latest, setLatest] = useState<PerformanceDiagnostic | null>(null);
  const [history, setHistory] = useState<PerformanceDiagnostic[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/apps/${appId}/performance-diagnostics/latest`);
      if (response.ok) {
        const result = (await response.json()) as PerformanceDiagnosticResponse;
        setLatest(result.diagnostic);
      }
    } catch {
      // Non-critical — the panel just starts empty and the operator can run a test.
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadHistory = async () => {
    try {
      const response = await fetch(`/api/apps/${appId}/performance-diagnostics/history?limit=20`);
      if (response.ok) {
        const result = (await response.json()) as PerformanceDiagnosticHistoryResponse;
        setHistory(result.history);
      }
    } catch {
      // Best-effort.
    }
  };

  const runTest = async () => {
    if (running) {
      return;
    }

    try {
      setRunning(true);
      setError("");
      setStage("Probing public route and container from the server...");

      const serverResponse = await fetch(`/api/apps/${appId}/performance-diagnostics/server`, { method: "POST" });
      const serverResult = (await serverResponse.json().catch(() => ({}))) as Partial<PerformanceDiagnosticResponse>;

      if (!serverResponse.ok || !serverResult.success || !serverResult.diagnostic) {
        throw new Error(serverResult.message || "Unable to complete performance diagnostics");
      }

      setLatest(serverResult.diagnostic);

      if (!publicDomain) {
        setStage("");
        return;
      }

      setStage("Measuring browser timing to the public app...");

      const { navigation, resources } = await collectBrowserTiming(publicDomain);

      const browserResponse = await fetch(
        `/api/apps/${appId}/performance-diagnostics/${serverResult.diagnostic.id}/browser`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diagnosticId: serverResult.diagnostic.id, navigation, resources })
        }
      );

      if (browserResponse.ok) {
        const browserResult = (await browserResponse.json()) as PerformanceDiagnosticResponse;
        if (browserResult.diagnostic) {
          setLatest(browserResult.diagnostic);
        }
      } else {
        setError(await readApiError(browserResponse, "Browser timing information was unavailable."));
      }

      if (showHistory) {
        void loadHistory();
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Unable to complete performance diagnostics");
    } finally {
      setStage("");
      setRunning(false);
    }
  };

  const toggleHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next) {
      void loadHistory();
    }
  };

  return (
    <div className="app-detail-tab-panel">
      <div className="env-scope-heading">
        <h3>Performance Diagnostics</h3>
        <div className="form-actions">
          <button className="secondary-button compact" type="button" onClick={toggleHistory}>
            {showHistory ? "Hide History" : "View History"}
          </button>
          <button className="primary-button compact" type="button" disabled={running} onClick={() => void runTest()}>
            {running ? "Running..." : latest ? "Run Again" : "Run Performance Test"}
          </button>
        </div>
      </div>

      <p className="section-description">
        Compares your browser's own connection to the public app against the deployment server's view of the
        same app — both the public route and the container directly — to help tell apart network distance,
        proxy/TLS delay, application slowness, and slow frontend assets. Server region: <strong>Europe</strong>.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {running && stage && <div className="notice-banner">{stage}</div>}

      {loading && !latest ? (
        <div className="empty-state">Loading...</div>
      ) : !latest ? (
        <div className="empty-state">No performance test has been run yet for this app.</div>
      ) : (
        <>
          <p className="text-faint">Last run: {new Date(latest.createdAt).toLocaleString()}</p>

          <div className="wizard-row-list">
            <div className="wizard-row">
              <strong>Browser → public app</strong>
              <dl className="wizard-review-grid">
                <div>
                  <dt>TTFB</dt>
                  <dd>
                    <span className={`status-badge compact ${TIER_TONE[tierFor(latest.browser.ttfbMs, THRESHOLDS.browserTtfb)]}`}>
                      {formatMs(latest.browser.ttfbMs)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Total load</dt>
                  <dd>
                    <span className={`status-badge compact ${TIER_TONE[tierFor(latest.browser.pageLoadMs, THRESHOLDS.pageLoad)]}`}>
                      {formatMs(latest.browser.pageLoadMs)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>DNS</dt>
                  <dd>{formatMs(latest.browser.dnsMs)}</dd>
                </div>
                <div>
                  <dt>TLS</dt>
                  <dd>{formatMs(latest.browser.tlsMs)}</dd>
                </div>
                <div>
                  <dt>Transferred</dt>
                  <dd>{formatBytes(latest.browser.transferBytes)}</dd>
                </div>
              </dl>
            </div>

            <div className="wizard-row">
              <strong>VPS → public app</strong>
              <dl className="wizard-review-grid">
                <div>
                  <dt>TTFB</dt>
                  <dd>
                    <span className={`status-badge compact ${TIER_TONE[tierFor(latest.publicProbe.ttfbMs, THRESHOLDS.publicTtfb)]}`}>
                      {formatMs(latest.publicProbe.ttfbMs)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Total time</dt>
                  <dd>{formatMs(latest.publicProbe.totalMs)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{latest.publicProbe.statusCode ?? "No response"}</dd>
                </div>
                <div>
                  <dt>TLS</dt>
                  <dd>{formatMs(latest.publicProbe.tlsMs)}</dd>
                </div>
              </dl>
              {latest.publicProbe.error && <p className="section-description">{latest.publicProbe.error}</p>}
            </div>

            <div className="wizard-row">
              <strong>VPS → container</strong>
              <dl className="wizard-review-grid">
                <div>
                  <dt>TTFB</dt>
                  <dd>{formatMs(latest.internalProbe.ttfbMs)}</dd>
                </div>
                <div>
                  <dt>Total time</dt>
                  <dd>
                    <span className={`status-badge compact ${TIER_TONE[tierFor(latest.internalProbe.totalMs, THRESHOLDS.internalTotal)]}`}>
                      {formatMs(latest.internalProbe.totalMs)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{latest.internalProbe.statusCode ?? "No response"}</dd>
                </div>
                <div>
                  <dt>Configured port</dt>
                  <dd>{latest.internalProbe.port ?? "Unknown"}</dd>
                </div>
              </dl>
              {latest.internalProbe.error && <p className="section-description">{latest.internalProbe.error}</p>}
            </div>
          </div>

          <div className="wizard-row inspection-card">
            <dl className="wizard-review-grid">
              <div>
                <dt>Likely bottleneck</dt>
                <dd>{latest.diagnosis.category ?? "Unknown"}</dd>
              </div>
            </dl>
            <p className="section-description">{latest.diagnosis.message ?? "No diagnosis available yet."}</p>
            {latest.diagnosis.evidence.length > 0 && (
              <>
                <p className="section-description">Evidence</p>
                <ul className="wizard-file-list">
                  {latest.diagnosis.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="form-actions form-actions-start">
            <button className="secondary-button compact" type="button" onClick={() => setShowDetails((v) => !v)}>
              {showDetails ? "Hide Details" : "View Details"}
            </button>
          </div>

          {showDetails && (
            <div className="wizard-row inspection-card">
              {latest.resourceSummary && latest.resourceSummary.length > 0 ? (
                <div className="table-wrap">
                  <table className="env-table">
                    <thead>
                      <tr>
                        <th>Category</th>
                        <th>Count</th>
                        <th>Total size</th>
                        <th>Total duration</th>
                        <th>Slowest</th>
                        <th>Failed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {latest.resourceSummary.map((row) => (
                        <tr key={row.category}>
                          <td>{row.category}</td>
                          <td>{row.count}</td>
                          <td>{formatBytes(row.totalTransferBytes)}</td>
                          <td>{formatMs(row.totalDurationMs)}</td>
                          <td>{row.slowestPath ?? "—"}</td>
                          <td>{row.failedCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="section-description">
                  No per-resource browser data is available. A cross-origin app's own JavaScript/CSS/font/image
                  requests cannot be read from this dashboard due to the browser's same-origin policy — only the
                  overall page timing above is measurable without navigating directly to the app.
                </p>
              )}
            </div>
          )}

          {showHistory && (
            <div className="wizard-row inspection-card">
              <p className="section-description">Recent runs (latest {history.length})</p>
              <div className="table-wrap">
                <table className="env-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Public TTFB</th>
                      <th>Internal total</th>
                      <th>Browser load</th>
                      <th>Diagnosis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((run) => (
                      <tr key={run.id}>
                        <td className="text-faint">{new Date(run.createdAt).toLocaleString()}</td>
                        <td>{formatMs(run.publicProbe.ttfbMs)}</td>
                        <td>{formatMs(run.internalProbe.totalMs)}</td>
                        <td>{formatMs(run.browser.pageLoadMs)}</td>
                        <td>{run.diagnosis.category ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
