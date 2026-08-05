import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSpeedtest } from "../hooks/useSpeedtest";

function reading(measuredAt: string) {
  return {
    success: true,
    configured: true,
    error: null,
    reading: {
      downloadHuman: "241.53 Mbps",
      uploadHuman: "40.99 Mbps",
      downloadBits: 241529872,
      uploadBits: 40987648,
      pingMs: 12.3,
      jitterMs: 1.8,
      packetLoss: 0,
      isp: "Example ISP",
      serverName: "Example Server",
      healthy: true,
      measuredAt
    }
  };
}

const OLD = "2026-08-05T09:00:00.000Z";
const NEW = "2026-08-05T10:00:00.000Z";

function json(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("useSpeedtest — running state", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("starts out not running and exposes the latest reading", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(reading(OLD))));

    const { result } = renderHook(() => useSpeedtest());

    await waitFor(() => expect(result.current.data?.reading?.measuredAt).toBe(OLD));
    expect(result.current.running).toBe(false);
  });

  test("enters the running state after a test is started", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return json({ success: true, message: "started" });
        }
        return json(reading(OLD));
      })
    );

    const { result } = renderHook(() => useSpeedtest());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.runTest();
    });

    expect(result.current.running).toBe(true);
  });

  test("leaves the running state once a newer reading arrives", async () => {
    let measuredAt = OLD;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return json({ success: true, message: "started" });
        }
        return json(reading(measuredAt));
      })
    );

    const { result } = renderHook(() => useSpeedtest());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.runTest();
    });
    expect(result.current.running).toBe(true);

    // The test finishes on the other service and a newer result appears.
    measuredAt = NEW;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    await waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.data?.reading?.measuredAt).toBe(NEW);
    expect(result.current.runTimedOut).toBe(false);
  });

  test("stays running while the reading is unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return json({ success: true, message: "started" });
        }
        return json(reading(OLD));
      })
    );

    const { result } = renderHook(() => useSpeedtest());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.runTest();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(result.current.running).toBe(true);
  });

  test("gives up after the timeout so the animation can't spin forever", async () => {
    // The test can fail or be skipped on the other service without ever
    // producing a new reading — the UI must not wait indefinitely.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return json({ success: true, message: "started" });
        }
        return json(reading(OLD));
      })
    );

    const { result } = renderHook(() => useSpeedtest());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.runTest();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 10_000);
    });

    await waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.runTimedOut).toBe(true);
  });

  test("a refused start surfaces the server's message and never enters the running state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return json({ success: false, message: 'The API token needs the "Run Speedtest" ability.' }, false);
        }
        return json(reading(OLD));
      })
    );

    const { result } = renderHook(() => useSpeedtest());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.runTest();
    });

    expect(result.current.running).toBe(false);
    expect(result.current.runError).toMatch(/Run Speedtest/);
  });
});
