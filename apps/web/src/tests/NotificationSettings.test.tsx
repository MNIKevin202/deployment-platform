import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NotificationSettings from "../components/NotificationSettings";

function json(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("NotificationSettings", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  test("loads config, then saves an edited webhook URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/notifications" && (!init || init.method === undefined)) {
        return json({ success: true, config: { enabled: false, type: "discord", webhookUrl: "" } });
      }
      return json({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NotificationSettings />);

    const urlInput = (await screen.findByPlaceholderText(/discord.com/)) as HTMLInputElement;
    await userEvent.type(urlInput, "https://example.com/hook");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/notifications",
        expect.objectContaining({ method: "PATCH" })
      );
    });
  });
});
