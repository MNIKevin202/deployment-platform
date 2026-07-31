import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MetricsPanel from "../components/MetricsPanel";
import type { ContainerMetrics, MetricsResponse } from "../types/api";

function baseMetrics(overrides: Partial<ContainerMetrics> = {}): ContainerMetrics {
  return {
    cpuPercent: 12.5,
    memoryUsageBytes: 256 * 1024 * 1024,
    memoryLimitBytes: 512 * 1024 * 1024,
    memoryPercent: 50,
    networkRxBytes: 1024,
    networkTxBytes: 2048,
    blockReadBytes: 4096,
    blockWriteBytes: 8192,
    pids: 5,
    ...overrides
  };
}

function mockFetchReturning(body: MetricsResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  );
}

describe("MetricsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders current values in the chart cards once metrics load", async () => {
    mockFetchReturning({ success: true, containerRunning: true, metrics: baseMetrics() });

    render(<MetricsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("12.5%")).toBeInTheDocument();
    });
    expect(screen.getByText("256.0 MB")).toBeInTheDocument();
    expect(screen.getByText(/of 512.0 MB \(50.0%\)/)).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  test("shows an empty state instead of charts when the container isn't running", async () => {
    mockFetchReturning({ success: true, containerRunning: false, metrics: null });

    render(<MetricsPanel appId={1} containerRunning={false} />);

    await waitFor(() => {
      expect(
        screen.getByText("The container is not running, so no live metrics are available.")
      ).toBeInTheDocument();
    });
  });

  test("Refresh re-fetches on demand", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, containerRunning: true, metrics: baseMetrics() }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<MetricsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    screen.getByRole("button", { name: "Refresh" }).click();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
