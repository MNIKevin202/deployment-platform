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
  lastRunAt: null
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
    const runButton = await screen.findByRole("button", { name: "Clean up now" });
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
});
