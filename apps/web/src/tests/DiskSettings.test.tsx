import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DiskSettings from "../components/DiskSettings";

function json(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const RETENTION_INFO = {
  success: true,
  config: { count: 3, platformImageKeep: 3 },
  defaults: { count: 3, platformImageKeep: 3 },
  lastRunAt: null,
  usage: {
    images: 185,
    containers: 182,
    volumes: 16,
    imagesSizeBytes: 35.6 * 1024 ** 3,
    usedBytes: 44 * 1024 ** 3,
    totalBytes: 96 * 1024 ** 3
  },
  usageError: null,
  lastCleanup: {
    scope: "global",
    appId: null,
    skipped: false,
    versionsPruned: 5,
    imagesDeleted: 10,
    imagesRetained: 20,
    containersRemoved: 3,
    bytesReclaimed: 38 * 1024 ** 3,
    durationMs: 4200,
    failures: [],
    at: Date.now() - 2 * 60 * 1000
  },
  lifetimeStats: {
    totalRuns: 12,
    totalImagesDeleted: 1284,
    totalContainersRemoved: 987,
    totalVersionsPruned: 400,
    totalBytesReclaimed: 612 * 1024 ** 3
  }
};

describe("DiskSettings", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  test("loads the retention config and runs a cleanup on demand", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/retention" && (!init || init.method === undefined)) {
        return json(RETENTION_INFO);
      }
      if (url === "/api/settings/retention/run") {
        return json({
          success: true,
          summary: {
            scope: "global",
            appId: null,
            skipped: false,
            versionsPruned: 4,
            imagesDeleted: 4,
            imagesRetained: 9,
            containersRemoved: 2,
            bytesReclaimed: 3 * 1024 ** 2,
            durationMs: 1200,
            failures: []
          }
        });
      }
      return json({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DiskSettings />);

    // Wait for the config to load (the run button is disabled until then).
    const runButton = await screen.findByRole("button", { name: "Run Cleanup Now" });
    await waitFor(() => expect(runButton).toBeEnabled());

    await userEvent.click(runButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/retention/run",
        expect.objectContaining({ method: "POST" })
      );
    });
    expect(await screen.findByText(/Removed 4 images and 2 containers/)).toBeInTheDocument();
  });

  test("saves an updated retention count", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/retention" && init?.method === "PATCH") {
        return json({ success: true, config: { count: 5, platformImageKeep: 3 } });
      }
      return json(RETENTION_INFO);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DiskSettings />);

    const saveButton = await screen.findByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton).toBeEnabled());

    const [countInput] = screen.getAllByRole("spinbutton");
    await userEvent.clear(countInput);
    await userEvent.type(countInput, "5");
    await userEvent.click(saveButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/retention",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ count: 5, platformImageKeep: 3 }) })
      );
    });
  });

  test("renders live Docker usage and lifetime cleanup statistics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(RETENTION_INFO)));

    render(<DiskSettings />);

    // Current Docker Usage.
    expect(await screen.findByText("185")).toBeInTheDocument(); // Images
    expect(screen.getByText("182")).toBeInTheDocument(); // Containers
    expect(screen.getByText("16")).toBeInTheDocument(); // Volumes
    expect(screen.getByText("35.6 GB")).toBeInTheDocument(); // Docker images size
    expect(screen.getByText("44.0 GB / 96.0 GB")).toBeInTheDocument(); // Disk used
    expect(screen.getByText("2 minutes ago")).toBeInTheDocument(); // Last cleanup

    // Cleanup Statistics (lifetime).
    expect(screen.getByText("1,284")).toBeInTheDocument(); // Images removed
    expect(screen.getByText("987")).toBeInTheDocument(); // Containers removed
    expect(screen.getByText("612.00 GB")).toBeInTheDocument(); // Space reclaimed
  });

  test("degrades gracefully when Docker usage is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ ...RETENTION_INFO, usage: null, usageError: "Unable to reach Docker." }))
    );

    render(<DiskSettings />);

    expect(await screen.findByText(/Unable to read live Docker usage/)).toBeInTheDocument();
  });
});
