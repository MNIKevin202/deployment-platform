import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DiskSettings from "../components/DiskSettings";

function json(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("DiskSettings", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  test("shows reclaimable space and prunes on demand", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/images/prune" && (!init || init.method === undefined)) {
        return json({ success: true, keepPerApp: 5, candidates: 3, reclaimableBytes: 3 * 1024 ** 2 });
      }
      if (url === "/api/images/prune/run") {
        return json({ success: true, removed: 3, reclaimedBytes: 3 * 1024 ** 2, failed: 0 });
      }
      return json({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DiskSettings />);

    expect(await screen.findByText(/3 images can be removed/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Prune now" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/images/prune/run", expect.objectContaining({ method: "POST" }));
    });
    expect(await screen.findByText(/Removed 3 images/)).toBeInTheDocument();
  });

  test("disables Prune now when nothing is reclaimable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ success: true, keepPerApp: 5, candidates: 0, reclaimableBytes: 0 }))
    );

    render(<DiskSettings />);

    expect(await screen.findByText(/0 images can be removed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prune now" })).toBeDisabled();
  });
});
