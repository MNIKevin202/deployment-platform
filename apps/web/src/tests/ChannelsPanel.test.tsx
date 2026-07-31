import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChannelsPanel from "../components/ChannelsPanel";
import type { IrcRegisteredChannel } from "../types/api";

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

describe("ChannelsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("shows an empty state instead of fetching when the container isn't running", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ChannelsPanel appId={1} containerRunning={false} />);

    expect(
      screen.getByText("The container is not running, so channels can't be listed right now.")
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("lists every active channel, registered or not", async () => {
    const channels: IrcRegisteredChannel[] = [
      { name: "#lobby", memberCount: 3, founder: "alice", registeredAt: "Fri, 31 Jul 2026 16:13:27 UTC" },
      { name: "#dev", memberCount: 1, founder: "bob", registeredAt: null },
      { name: "#random", memberCount: 2, founder: null, registeredAt: null }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ success: true, channels }))
    );

    render(<ChannelsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("#lobby")).toBeInTheDocument();
    });
    expect(screen.getByText(/Founder: alice/)).toBeInTheDocument();
    expect(screen.getByText("#dev")).toBeInTheDocument();
    expect(screen.getByText(/Founder: bob/)).toBeInTheDocument();
    expect(screen.getByText("#random")).toBeInTheDocument();
    expect(screen.getByText(/Not registered/)).toBeInTheDocument();
  });

  test("an unregistered channel shows no Manage button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          success: true,
          channels: [{ name: "#random", memberCount: 2, founder: null, registeredAt: null }]
        })
      )
    );

    render(<ChannelsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("#random")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Manage" })).not.toBeInTheDocument();
  });

  test("shows an empty state when no channels are active", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ success: true, channels: [] }))
    );

    render(<ChannelsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("No channels are currently active on this server.")).toBeInTheDocument();
    });
  });

  test("unregistering a channel requires confirmation, then sends the request and refreshes", async () => {
    let unregisterCalled = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/unregister")) {
          unregisterCalled = true;
          return jsonResponse({ success: true, message: "Channel #lobby is now unregistered" });
        }
        if (init?.method === undefined || init.method === "GET") {
          return jsonResponse({
            success: true,
            channels: unregisterCalled
              ? []
              : [{ name: "#lobby", memberCount: 1, founder: "alice", registeredAt: null }]
          });
        }
        return jsonResponse({ success: true, channels: [] });
      })
    );

    render(<ChannelsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("#lobby")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Manage" }));
    await userEvent.click(screen.getByRole("button", { name: "Unregister" }));
    expect(screen.getByText(/This can't be undone/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Confirm Unregister" }));

    await waitFor(() => {
      expect(screen.getByText("No channels are currently active on this server.")).toBeInTheDocument();
    });
    expect(unregisterCalled).toBe(true);
  });

  test("transferring a channel posts the new founder and refreshes", async () => {
    let transferBody: unknown = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/transfer") && init?.method === "POST") {
          transferBody = JSON.parse(init.body as string);
          return jsonResponse({ success: true, message: "Channel #lobby transferred" });
        }
        return jsonResponse({
          success: true,
          channels: [{ name: "#lobby", memberCount: 1, founder: "alice", registeredAt: null }]
        });
      })
    );

    render(<ChannelsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("#lobby")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Manage" }));
    await userEvent.type(screen.getByPlaceholderText("newowner"), "bob");
    await userEvent.click(screen.getByRole("button", { name: "Transfer Ownership" }));

    await waitFor(() => {
      expect(transferBody).toEqual({ newFounder: "bob" });
    });
  });
});
