import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "../pages/SettingsPage";

describe("SettingsPage — backup & restore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders backup and restore sections", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("button", { name: "Download backup" })).toBeInTheDocument();
    expect(screen.getByText("Restore from a backup")).toBeInTheDocument();
  });

  test("uploading a backup and confirming posts it to the restore endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, message: "Backup restored. The platform is restarting…" })
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsPage />);

    const file = new File([new Uint8Array([1, 2, 3])], "backup.tar.gz", { type: "application/gzip" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, file);

    expect(screen.getByText(/Selected: backup.tar.gz/)).toBeInTheDocument();

    // Open the destructive confirmation, then confirm.
    await userEvent.click(screen.getByRole("button", { name: /Restore & restart/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Restore & restart/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/restore",
        expect.objectContaining({ method: "POST" })
      );
    });

    expect(await screen.findByText(/platform is restarting/i)).toBeInTheDocument();
  });

  test("surfaces a restore error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        // The DiskSettings card on the same page loads image info on mount —
        // keep it happy so only the restore path produces "Bad archive".
        if (url === "/api/images/prune") {
          return { ok: true, json: async () => ({ success: true, keepPerApp: 5, candidates: 0, reclaimableBytes: 0 }) } as Response;
        }
        return { ok: false, json: async () => ({ success: false, message: "Bad archive" }) } as Response;
      })
    );

    render(<SettingsPage />);

    const file = new File([new Uint8Array([9])], "bad.tar.gz", { type: "application/gzip" });
    await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    await userEvent.click(screen.getByRole("button", { name: /Restore & restart/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Restore & restart/ }));

    expect(await screen.findByText("Bad archive")).toBeInTheDocument();
  });
});
