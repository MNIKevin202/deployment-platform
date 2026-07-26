import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  normalizeDockerStats,
  getContainerMetrics
} from "../services/docker-metrics-service.js";

function baseRawStats() {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000, percpu_usage: [1, 2] },
      system_cpu_usage: 20_000_000_000,
      online_cpus: 2
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000_000_000 },
      system_cpu_usage: 10_000_000_000
    },
    memory_stats: {
      usage: 100_000_000,
      limit: 500_000_000,
      stats: { cache: 20_000_000 }
    },
    networks: {
      eth0: { rx_bytes: 1000, tx_bytes: 2000 }
    },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: "Read", value: 4096 },
        { op: "Write", value: 8192 }
      ]
    },
    pids_stats: { current: 7 }
  };
}

describe("normalizeDockerStats", () => {
  test("computes CPU percentage using the standard delta formula", () => {
    const result = normalizeDockerStats(baseRawStats());
    // cpuDelta=1e9, systemDelta=1e10, onlineCpus=2 -> (1e9/1e10)*2*100 = 20
    assert.equal(result.cpuPercent, 20);
  });

  test("computes memory usage subtracting cache, and percent against the limit", () => {
    const result = normalizeDockerStats(baseRawStats());
    assert.equal(result.memoryUsageBytes, 80_000_000);
    assert.equal(result.memoryLimitBytes, 500_000_000);
    assert.equal(result.memoryPercent, 16);
  });

  test("aggregates multiple network interfaces", () => {
    const raw = baseRawStats();
    (raw.networks as Record<string, unknown>).eth1 = { rx_bytes: 500, tx_bytes: 250 };

    const result = normalizeDockerStats(raw);
    assert.equal(result.networkRxBytes, 1500);
    assert.equal(result.networkTxBytes, 2250);
  });

  test("aggregates block I/O read and write separately", () => {
    const result = normalizeDockerStats(baseRawStats());
    assert.equal(result.blockReadBytes, 4096);
    assert.equal(result.blockWriteBytes, 8192);
  });

  test("returns process count when available", () => {
    const result = normalizeDockerStats(baseRawStats());
    assert.equal(result.pids, 7);
  });

  test("handles no memory limit set (unlimited) without throwing", () => {
    const raw = baseRawStats();
    (raw.memory_stats as Record<string, unknown>).limit = 0;

    const result = normalizeDockerStats(raw);
    assert.equal(result.memoryLimitBytes, null);
    assert.equal(result.memoryPercent, null);
    // Usage is still reported even without a limit.
    assert.ok(typeof result.memoryUsageBytes === "number");
  });

  test("degrades gracefully on malformed or missing sections instead of throwing", () => {
    assert.doesNotThrow(() => normalizeDockerStats({}));
    assert.doesNotThrow(() => normalizeDockerStats(null));
    assert.doesNotThrow(() => normalizeDockerStats(undefined));
    assert.doesNotThrow(() => normalizeDockerStats("not an object"));

    const result = normalizeDockerStats({});
    assert.equal(result.cpuPercent, null);
    assert.equal(result.memoryUsageBytes, null);
    assert.equal(result.networkRxBytes, null);
    assert.equal(result.blockReadBytes, null);
    assert.equal(result.pids, null);
  });

  test("handles a partial stats object where only some sections are present", () => {
    const result = normalizeDockerStats({
      pids_stats: { current: 3 }
    });

    assert.equal(result.pids, 3);
    assert.equal(result.cpuPercent, null);
    assert.equal(result.memoryUsageBytes, null);
  });

  test("returns 0 cpu percent (not null) when there is no CPU activity between samples", () => {
    const raw = baseRawStats();
    (raw.cpu_stats.cpu_usage as { total_usage: number }).total_usage = 1_000_000_000;
    // Same as precpu -> zero delta.
    const result = normalizeDockerStats(raw);
    assert.equal(result.cpuPercent, 0);
  });
});

interface FakeContainer {
  stats: (options: { stream: boolean }) => Promise<unknown>;
}

function createFakeDocker(container: FakeContainer) {
  return {
    getContainer: () => container
  } as unknown as import("dockerode");
}

describe("getContainerMetrics", () => {
  test("returns normalized metrics on success, using a single unstreamed stats call", async () => {
    let requestedStream: boolean | undefined;

    const docker = createFakeDocker({
      stats: async ({ stream }) => {
        requestedStream = stream;
        return baseRawStats();
      }
    });

    const result = await getContainerMetrics(docker, "container-1");

    assert.equal(result.success, true);
    assert.equal(requestedStream, false);
    if (result.success) {
      assert.equal(result.metrics.cpuPercent, 20);
    }
  });

  test("reports a not-found reason for a missing/stopped container", async () => {
    const docker = createFakeDocker({
      stats: async () => {
        const error = new Error("no such container") as Error & { statusCode?: number };
        error.statusCode = 404;
        throw error;
      }
    });

    const result = await getContainerMetrics(docker, "missing");

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, "not-found");
    }
  });

  test("reports a generic error for unexpected Docker failures", async () => {
    const docker = createFakeDocker({
      stats: async () => {
        throw new Error("Docker daemon unreachable");
      }
    });

    const result = await getContainerMetrics(docker, "container-1");

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, "error");
    }
  });
});
