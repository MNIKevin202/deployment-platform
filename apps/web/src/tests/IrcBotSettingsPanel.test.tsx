import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import IrcBotSettingsPanel from "../components/IrcBotSettingsPanel";
import type { BotConfig, BotStatus } from "../types/api";

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

function defaultStatus(overrides: Partial<BotStatus> = {}): BotStatus {
  return {
    connected: true,
    nick: "QuiporaBot",
    nickRegistered: false,
    joinedChannels: ["#support"],
    ...overrides
  };
}

function defaultConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    welcomeMessageTemplate: "",
    commandPrefix: "!",
    rulesText: "",
    botCommands: {},
    bannedWords: [],
    moderationAction: "warn",
    nickRegistered: false,
    ...overrides
  };
}

function stubFetch(status: BotStatus, config: BotConfig, onRegister?: (body: unknown) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/bot/status")) {
        return jsonResponse({ success: true, status });
      }
      if (url.includes("/bot/register-nick") && init) {
        const body = JSON.parse(init.body as string);
        return onRegister ? onRegister(body) : jsonResponse({ ok: true, message: "Account created." });
      }
      if (url.includes("/bot/config")) {
        return jsonResponse({ success: true, config });
      }
      return jsonResponse({ success: false }, false);
    })
  );
}

describe("IrcBotSettingsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("shows an empty state instead of fetching when the container isn't running", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<IrcBotSettingsPanel appId={1} containerRunning={false} />);

    expect(
      screen.getByText("The bot's container is not running, so its settings can't be changed right now.")
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("shows the bot's current nick and connection state on the Identity tab", async () => {
    stubFetch(defaultStatus(), defaultConfig());
    render(<IrcBotSettingsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("QuiporaBot")).toBeInTheDocument();
    });
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
    expect(screen.getByText(/Not registered/)).toBeInTheDocument();
  });

  test("registering a nickname posts the password and shows the result", async () => {
    stubFetch(defaultStatus(), defaultConfig());
    render(<IrcBotSettingsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByText("QuiporaBot")).toBeInTheDocument();
    });

    await userEvent.type(screen.getByPlaceholderText("A new NickServ account password"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Register Nickname" }));

    await waitFor(() => {
      expect(screen.getByText("Account created.")).toBeInTheDocument();
    });
  });

  test("the Commands tab lists and saves custom commands", async () => {
    stubFetch(defaultStatus(), defaultConfig({ botCommands: { "!discord": "https://discord.example" } }));
    render(<IrcBotSettingsPanel appId={1} containerRunning />);

    await userEvent.click(screen.getByRole("tab", { name: "Commands" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("!discord")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("https://discord.example")).toBeInTheDocument();
  });

  test("the Moderation tab shows the current banned words and action", async () => {
    stubFetch(defaultStatus(), defaultConfig({ bannedWords: ["spam"], moderationAction: "kick" }));
    render(<IrcBotSettingsPanel appId={1} containerRunning />);

    await userEvent.click(screen.getByRole("tab", { name: "Moderation" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("spam")).toBeInTheDocument();
    });
    expect(screen.getByRole("radio", { name: "Warn and kick" })).toBeChecked();
  });
});
