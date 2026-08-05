import { useCallback, useEffect, useRef, useState } from "react";
import type { SpeedtestLatestResponse } from "../types/api";

/**
 * The latest internet-speed reading, shared by the Overview card and the
 * System page. Polled slowly on purpose: the value only changes when a
 * scheduled speedtest runs (typically hourly), the API caches it server-side
 * anyway, and every fetch reaches out to a separate service.
 */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

export interface SpeedtestState {
  loading: boolean;
  data: SpeedtestLatestResponse | null;
}

export function useSpeedtest(): SpeedtestState {
  const [data, setData] = useState<SpeedtestLatestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Stops a poll tick from stacking a second request on a slow one.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const response = await fetch("/api/speedtest/latest");
      if (response.ok) {
        setData((await response.json().catch(() => null)) as SpeedtestLatestResponse | null);
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
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  return { loading, data };
}
