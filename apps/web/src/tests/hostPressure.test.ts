import { describe, expect, test } from "vitest";
import { computeHostPressure, formatMib } from "../lib/hostPressure";
import type { StoredApp } from "../types/api";

function app(memoryLimitMb: number | null): StoredApp {
  return { memoryLimitMb } as StoredApp;
}

const GiB = 1024 * 1024 * 1024;

describe("computeHostPressure", () => {
  test("ok when nothing is committed", () => {
    const p = computeHostPressure([app(null), app(null)], 8 * GiB);
    expect(p.committedMb).toBe(0);
    expect(p.cappedCount).toBe(0);
    expect(p.level).toBe("ok");
  });

  test("sums limits and counts capped apps", () => {
    const p = computeHostPressure([app(512), app(1024), app(null)], 8 * GiB);
    expect(p.committedMb).toBe(1536);
    expect(p.cappedCount).toBe(2);
    expect(p.level).toBe("ok");
  });

  test("warns when committed nears the host total", () => {
    // Host 2 GiB = 2048 MB; commit 1800 MB → ~88% → warning.
    const p = computeHostPressure([app(1800)], 2 * GiB);
    expect(p.level).toBe("warning");
  });

  test("flags over-commit past the host total", () => {
    const p = computeHostPressure([app(3000)], 2 * GiB);
    expect(p.level).toBe("over");
    expect(p.ratio).toBeGreaterThan(1);
  });

  test("stays ok when host memory is unknown", () => {
    expect(computeHostPressure([app(4000)], null).level).toBe("ok");
  });
});

describe("formatMib", () => {
  test("formats MB and GB", () => {
    expect(formatMib(512)).toBe("512 MB");
    expect(formatMib(2048)).toBe("2.0 GB");
  });
});
