import { useCallback, useEffect, useRef, useState } from "react";
import type { SpeedtestLatestResponse } from "../types/api";

/**
 * The latest internet-speed reading, shared by the Overview card and the
 * System page. Polled slowly on purpose: the value only changes when a
 * speedtest runs (every few hours by default), the API caches it
 * server-side anyway, and every fetch reaches out to a separate service.
 */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * While a test is running, poll often enough that the result appears
 * promptly — a test takes roughly a minute, so this is a short burst of
 * activity, not the steady state.
 */
const RUNNING_POLL_INTERVAL_MS = 5000;

/**
 * Stop waiting eventually. The test runs on the other service, so it can
 * fail (or be skipped by SPEEDTEST_SKIP_IPS) without ever producing a new
 * reading — the UI must not spin forever if that happens.
 */
const RUNNING_TIMEOUT_MS = 3 * 60 * 1000;

export interface SpeedtestState {
  loading: boolean;
  data: SpeedtestLatestResponse | null;
  /** True from starting a test until a newer reading lands (or the wait times out). */
  running: boolean;
  /** Set when starting a test failed — e.g. the token lacks "Run Speedtest". */
  runError: string;
  /** Set when the wait gave up before a new reading appeared. */
  runTimedOut: boolean;
  runTest: () => Promise<void>;
}

export function useSpeedtest(): SpeedtestState {
  const [data, setData] = useState<SpeedtestLatestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [runTimedOut, setRunTimedOut] = useState(false);

  // Stops a poll tick from stacking a second request on a slow one.
  const inFlight = useRef(false);
  // The reading we're waiting to see replaced, captured when the test starts.
  const baselineMeasuredAt = useRef<string | null>(null);
  const runStartedAt = useRef<number>(0);
  const runningRef = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const response = await fetch("/api/speedtest/latest");
      if (!response.ok) {
        return;
      }
      const next = (await response.json().catch(() => null)) as SpeedtestLatestResponse | null;
      setData(next);

      // A reading newer than the one present when the test started means the
      // run finished — stop waiting and let the fresh numbers show.
      if (runningRef.current) {
        const measuredAt = next?.reading?.measuredAt ?? null;
        if (measuredAt && measuredAt !== baselineMeasuredAt.current) {
          runningRef.current = false;
          setRunning(false);
        } else if (Date.now() - runStartedAt.current > RUNNING_TIMEOUT_MS) {
          runningRef.current = false;
          setRunning(false);
          setRunTimedOut(true);
        }
      }
    } catch {
      // A missing reading is never worth surfacing as a page-level error —
      // the card simply doesn't render.
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Polls faster while a test is in flight, then drops back to the slow cadence.
  useEffect(() => {
    const interval = window.setInterval(
      () => void load(),
      running ? RUNNING_POLL_INTERVAL_MS : POLL_INTERVAL_MS
    );
    return () => window.clearInterval(interval);
  }, [load, running]);

  const runTest = useCallback(async () => {
    setRunError("");
    setRunTimedOut(false);

    try {
      const response = await fetch("/api/speedtest/run", { method: "POST" });
      const result = (await response.json().catch(() => null)) as { message?: string } | null;

      if (!response.ok) {
        setRunError(result?.message || "Could not start a speed test.");
        return;
      }

      // Remember what "old" looks like before waiting for something newer.
      baselineMeasuredAt.current = data?.reading?.measuredAt ?? null;
      runStartedAt.current = Date.now();
      runningRef.current = true;
      setRunning(true);
    } catch {
      setRunError("Could not start a speed test.");
    }
  }, [data]);

  return { loading, data, running, runError, runTimedOut, runTest };
}
