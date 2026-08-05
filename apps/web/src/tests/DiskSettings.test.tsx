import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    runningContainers: 14,
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
    totalBytesReclaimed: 612 * 1024 ** 3,
    largestCleanupBytes: 96 * 1024 ** 3
  },
  history: [] as unknown[]
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
    expect(
      await screen.findByText(/Removed 4 images and 2 containers.*Docker data reclaimed in 1\.2s/)
    ).toBeInTheDocument();
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

  test("renders live Docker usage (with disk percent + running/total containers) and lifetime cleanup statistics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(RETENTION_INFO)));

    render(<DiskSettings />);

    // Current Docker Usage.
    expect(await screen.findByText("185")).toBeInTheDocument(); // Docker images
    expect(screen.getByText("14")).toBeInTheDocument(); // Running containers
    expect(screen.getByText("182")).toBeInTheDocument(); // Total containers
    expect(screen.getByText("16")).toBeInTheDocument(); // Volumes
    expect(screen.getByText("35.6 GB")).toBeInTheDocument(); // Docker image size
    expect(screen.getByText("44.0 GB / 96.0 GB (46%)")).toBeInTheDocument(); // Disk used with percent
    expect(screen.getByText("2 minutes ago")).toBeInTheDocument(); // Last cleanup

    // Lifetime Cleanup Statistics.
    expect(screen.getByText("Lifetime Cleanup Statistics")).toBeInTheDocument();
    expect(screen.getByText("1,284")).toBeInTheDocument(); // Images removed
    expect(screen.getByText("987")).toBeInTheDocument(); // Containers removed
    expect(screen.getByText("612.00 GB")).toBeInTheDocument(); // Docker data reclaimed
    expect(screen.getByText("96.00 GB")).toBeInTheDocument(); // Largest cleanup
    expect(screen.getByText("12")).toBeInTheDocument(); // Total cleanup runs
  });

  test("shows a persisted usage error only when idle, not while a cleanup is in flight", async () => {
    const erroredInfo = { ...RETENTION_INFO, usage: null, usageError: "Docker is slow right now." };
    let resolveRun: ((response: Response) => void) | null = null;
    const runPromise = new Promise<Response>((resolve) => {
      resolveRun = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/settings/retention/run") {
          return runPromise;
        }
        return json(erroredInfo);
      })
    );

    render(<DiskSettings />);

    // Idle: the persisted error is visible.
    expect(await screen.findByText(/Unable to read live Docker usage: Docker is slow right now\./)).toBeInTheDocument();

    const runButton = screen.getByRole("button", { name: "Run Cleanup Now" });
    await userEvent.click(runButton);

    // While the cleanup is in flight, the error is suppressed in favor of a
    // non-alarming in-progress state, and the button shows a spinner and is disabled.
    await waitFor(() => {
      expect(screen.queryByText(/Unable to read live Docker usage/)).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Running cleanup/ })).toBeDisabled();

    resolveRun?.(
      json({
        success: true,
        summary: {
          scope: "global",
          appId: null,
          skipped: false,
          versionsPruned: 0,
          imagesDeleted: 0,
          imagesRetained: 0,
          containersRemoved: 0,
          bytesReclaimed: 0,
          durationMs: 500,
          failures: []
        }
      })
    );

    // Idle again: the (still-persisted) error reappears.
    await waitFor(() => {
      expect(screen.getByText(/Unable to read live Docker usage: Docker is slow right now\./)).toBeInTheDocument();
    });
  });

  test("the completion banner shows a timestamp, is dismissible, and links to cleanup history", async () => {
    const historyEntry = {
      scope: "global",
      appId: null,
      skipped: false,
      versionsPruned: 2,
      imagesDeleted: 5,
      imagesRetained: 6,
      containersRemoved: 1,
      bytesReclaimed: 2 * 1024 ** 3,
      durationMs: 3000,
      failures: [],
      at: Date.now()
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/retention/run") {
        return json({ success: true, summary: historyEntry });
      }
      // After the cleanup, the reload picks up the new history entry.
      return json({ ...RETENTION_INFO, history: [historyEntry] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DiskSettings />);

    const runButton = await screen.findByRole("button", { name: "Run Cleanup Now" });
    await waitFor(() => expect(runButton).toBeEnabled());
    await userEvent.click(runButton);

    const banner = await screen.findByText(/View details/);
    const bannerContainer = banner.closest(".notice-banner");
    expect(bannerContainer).not.toBeNull();

    // A timestamp is shown in the banner (bold, ahead of the message).
    const timestampNode = (bannerContainer as HTMLElement).querySelector("strong");
    expect(timestampNode?.textContent).toMatch(/\d/);

    // The history table now has a row for this cleanup.
    expect(await screen.findByText("Cleanup history")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("5")).toBeInTheDocument(); // Images Removed
    expect(within(table).getByText("2.00 GB")).toBeInTheDocument(); // Docker Data Reclaimed

    // Dismiss the banner.
    await userEvent.click(within(bannerContainer as HTMLElement).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/View details/)).not.toBeInTheDocument();
  });

  test("shows an empty state when no cleanups have run yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(RETENTION_INFO)));

    render(<DiskSettings />);

    expect(await screen.findByText("No cleanups recorded yet.")).toBeInTheDocument();
  });

  test("degrades gracefully when Docker usage is unavailable while idle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ ...RETENTION_INFO, usage: null, usageError: "Unable to reach Docker." }))
    );

    render(<DiskSettings />);

    expect(await screen.findByText(/Unable to read live Docker usage/)).toBeInTheDocument();
  });
});
