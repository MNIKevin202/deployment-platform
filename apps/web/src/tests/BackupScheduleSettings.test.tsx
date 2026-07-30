import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BackupScheduleSettings from "../components/BackupScheduleSettings";

function json(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("BackupScheduleSettings", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  test("shows current state and triggers a backup on demand", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/auto-backup" && (!init || init.method === undefined)) {
        return json({
          success: true,
          config: { enabled: true, intervalHours: 24, retention: 7 },
          lastRunAt: null,
          backups: []
        });
      }
      if (url === "/api/settings/auto-backup/run") {
        return json({ success: true, backups: [{ name: "auto-backup-x.tar.gz", sizeBytes: 100, createdAt: "" }] });
      }
      return json({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BackupScheduleSettings />);

    expect(await screen.findByText(/Last automatic backup: never/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Back up now" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/auto-backup/run",
        expect.objectContaining({ method: "POST" })
      );
    });
    expect(await screen.findByText("Backup created.")).toBeInTheDocument();
  });
});
