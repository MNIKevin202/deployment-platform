import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChannelsPanel from "../components/ChannelsPanel";
import type { IrcChannelDetail, IrcRegisteredChannel } from "../types/api";

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

function defaultChannels(): IrcRegisteredChannel[] {
  return [
    { name: "#lobby", memberCount: 3, founder: "alice", registeredAt: "Fri, 31 Jul 2026 16:13:27 UTC" },
    { name: "#random", memberCount: 2, founder: null, registeredAt: null }
  ];
}

function defaultDetail(overrides: Partial<IrcChannelDetail> = {}): IrcChannelDetail {
  return {
    name: "#lobby",
    topic: "Welcome!",
    memberCount: 2,
    founder: "alice",
    registeredAt: "Fri, 31 Jul 2026 16:13:27 UTC",
    members: [
      { nick: "alice", isOp: true },
      { nick: "bob", isOp: false }
    ],
    ...overrides
  };
}

function stubFetch(handlers: {
  channels?: IrcRegisteredChannel[];
  blocked?: string[];
  detail?: IrcChannelDetail;
  onAction?: (url: string, init?: RequestInit) => Response | null;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const custom = handlers.onAction?.(url, init);
      if (custom) {
        return custom;
      }
      if (url.includes("/irc/blocked-channels")) {
        return jsonResponse({ success: true, channels: handlers.blocked ?? [] });
      }
      if (url.match(/\/irc\/channels\/[^/]+$/)) {
        return jsonResponse({ success: true, channel: handlers.detail ?? defaultDetail() });
      }
      if (url.endsWith("/irc/channels")) {
        return jsonResponse({ success: true, channels: handlers.channels ?? defaultChannels() });
      }
      return jsonResponse({ success: true });
    })
  );
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

  test("lists every active channel as a card with a registered/not badge", async () => {
    stubFetch({});
    render(<ChannelsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("#lobby")).toBeInTheDocument();
    });
    expect(document.querySelector(".status-badge.positive")?.textContent).toBe("Registered");
    expect(screen.getByText("#random")).toBeInTheDocument();
    expect(screen.getByText("Not registered")).toBeInTheDocument();
  });

  test("shows an empty state when no channels are active", async () => {
    stubFetch({ channels: [] });
    render(<ChannelsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("No channels are currently active on this server.")).toBeInTheDocument();
    });
  });

  test("opening Details loads and shows topic, founder, and members", async () => {
    stubFetch({});
    render(<ChannelsPanel appId={1} containerRunning />);

    await waitFor(() => expect(screen.getByText("#lobby")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);

    await waitFor(() => {
      expect(screen.getByText("Welcome!")).toBeInTheDocument();
    });
    expect(screen.getByText("Members (2)")).toBeInTheDocument();
    expect(screen.getByText("@alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  test("kicking a member posts to the kick endpoint and refreshes", async () => {
    let kicked = false;
    stubFetch({
      onAction: (url, init) => {
        if (url.includes("/kick") && init?.method === "POST") {
          kicked = true;
          return jsonResponse({ success: true, message: "kicked" });
        }
        return null;
      }
    });

    render(<ChannelsPanel appId={1} containerRunning />);
    await waitFor(() => expect(screen.getByText("#lobby")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());

    const bobRow = screen.getByText("bob").closest(".wizard-row");
    expect(bobRow).not.toBeNull();
    await userEvent.click(within(bobRow as HTMLElement).getByRole("button", { name: "Kick" }));

    await waitFor(() => expect(kicked).toBe(true));
  });

  test("opping a member posts grant:true, de-opping posts grant:false", async () => {
    let lastOpBody: unknown = null;
    stubFetch({
      onAction: (url, init) => {
        if (url.includes("/op") && init?.method === "POST") {
          lastOpBody = JSON.parse(init.body as string);
          return jsonResponse({ success: true, message: "ok" });
        }
        return null;
      }
    });

    render(<ChannelsPanel appId={1} containerRunning />);
    await waitFor(() => expect(screen.getByText("#lobby")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());

    const bobRow = screen.getByText("bob").closest(".wizard-row") as HTMLElement;
    await userEvent.click(within(bobRow).getByRole("button", { name: "Op" }));
    await waitFor(() => expect(lastOpBody).toEqual({ nick: "bob", grant: true }));
  });

  test("blocking a channel requires confirmation, then posts to the block endpoint", async () => {
    let blocked = false;
    stubFetch({
      onAction: (url, init) => {
        if (url.endsWith("/block") && init?.method === "POST") {
          blocked = true;
          return jsonResponse({ success: true, message: "blocked" });
        }
        return null;
      }
    });

    render(<ChannelsPanel appId={1} containerRunning />);
    await waitFor(() => expect(screen.getByText("#lobby")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    await waitFor(() => expect(screen.getByText("Welcome!")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Block Channel" }));
    expect(screen.getByText(/Block this channel forever/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm Block" }));

    await waitFor(() => expect(blocked).toBe(true));
  });

  test("Blocked Channels section lists blocked channels with an Unblock button", async () => {
    stubFetch({ blocked: ["#spam"] });
    render(<ChannelsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("#spam")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Unblock" })).toBeInTheDocument();
  });

  test("shows an empty state when nothing is blocked", async () => {
    stubFetch({ blocked: [] });
    render(<ChannelsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("No channels are blocked.")).toBeInTheDocument();
    });
  });

  test("unblocking calls DELETE on the block endpoint and refreshes", async () => {
    let unblocked = false;
    let firstLoad = true;
    stubFetch({
      onAction: (url, init) => {
        if (url.includes("/irc/blocked-channels")) {
          if (firstLoad) {
            firstLoad = false;
            return jsonResponse({ success: true, channels: ["#spam"] });
          }
          return jsonResponse({ success: true, channels: unblocked ? [] : ["#spam"] });
        }
        if (url.endsWith("/block") && init?.method === "DELETE") {
          unblocked = true;
          return jsonResponse({ success: true, message: "unblocked" });
        }
        return null;
      }
    });

    render(<ChannelsPanel appId={1} containerRunning />);
    await waitFor(() => expect(screen.getByText("#spam")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Unblock" }));

    await waitFor(() => expect(unblocked).toBe(true));
  });

  test("transferring a channel posts the new founder and refreshes", async () => {
    let transferBody: unknown = null;
    stubFetch({
      onAction: (url, init) => {
        if (url.endsWith("/transfer") && init?.method === "POST") {
          transferBody = JSON.parse(init.body as string);
          return jsonResponse({ success: true, message: "Channel #lobby transferred" });
        }
        return null;
      }
    });

    render(<ChannelsPanel appId={1} containerRunning />);
    await waitFor(() => expect(screen.getByText("#lobby")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    await waitFor(() => expect(screen.getByPlaceholderText("newowner")).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText("newowner"), "bob");
    await userEvent.click(screen.getByRole("button", { name: "Transfer Ownership" }));

    await waitFor(() => {
      expect(transferBody).toEqual({ newFounder: "bob" });
    });
  });

  test("unregistering a channel requires confirmation, then sends the request", async () => {
    let unregisterCalled = false;
    stubFetch({
      onAction: (url, init) => {
        if (url.endsWith("/unregister") && init?.method === "POST") {
          unregisterCalled = true;
          return jsonResponse({ success: true, message: "Channel #lobby is now unregistered" });
        }
        return null;
      }
    });

    render(<ChannelsPanel appId={1} containerRunning />);
    await waitFor(() => expect(screen.getByText("#lobby")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    await waitFor(() => expect(screen.getByText("Welcome!")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Unregister" }));
    expect(screen.getByText(/This can't be undone/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm Unregister" }));

    await waitFor(() => expect(unregisterCalled).toBe(true));
  });
});
