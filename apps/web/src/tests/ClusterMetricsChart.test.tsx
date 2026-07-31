import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ClusterMetricsChart from "../components/ClusterMetricsChart";
import type { MetricsSummaryResponse } from "../types/api";

function mockFetchOnce(body: MetricsSummaryResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  );
}

describe("ClusterMetricsChart", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders the aggregate CPU and memory reading from the summary endpoint", async () => {
    mockFetchOnce({
      success: true,
      sampledAt: new Date().toISOString(),
      sampledCount: 2,
      cpuPercentTotal: 34.5,
      memoryUsageBytesTotal: 512 * 1024 * 1024
    });

    render(<ClusterMetricsChart dockerInfo={null} />);

    await waitFor(() => {
      expect(screen.getByText("34.5%")).toBeInTheDocument();
    });
    expect(screen.getByText("512.0 MB")).toBeInTheDocument();
  });

  test("shows host capacity context when dockerInfo is available", async () => {
    mockFetchOnce({
      success: true,
      sampledAt: new Date().toISOString(),
      sampledCount: 1,
      cpuPercentTotal: 50,
      memoryUsageBytesTotal: 1024 * 1024 * 1024
    });

    render(
      <ClusterMetricsChart
        dockerInfo={{
          status: "connected",
          containers: 5,
          containersRunning: 3,
          containersStopped: 2,
          images: 10,
          dockerVersion: "24.0",
          operatingSystem: "Linux",
          architecture: "x86_64",
          cpuCount: 4,
          memoryTotalBytes: 8 * 1024 * 1024 * 1024
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/of 400% capacity \(4 cores\)/)).toBeInTheDocument();
    });
    expect(screen.getByText(/of 8.0 GB total/)).toBeInTheDocument();
  });

  test("renders nothing when the endpoint fails and no sample has ever landed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 502 }))
    );

    const { container } = render(<ClusterMetricsChart dockerInfo={null} />);

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });
});
