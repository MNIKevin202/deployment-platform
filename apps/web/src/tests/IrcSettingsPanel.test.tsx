import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import IrcSettingsPanel from "../components/IrcSettingsPanel";
import type { IrcGeneralSettings, IrcOperator } from "../types/api";

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

function defaultSettings(overrides: Partial<IrcGeneralSettings> = {}): IrcGeneralSettings {
  return {
    networkName: "ExampleNet",
    autoJoinChannels: [],
    defaultChannelModes: "+ntC",
    maxChannelsPerClient: 100,
    channelRegistrationEnabled: true,
    channelRegistrationOperatorOnly: false,
    maxChannelsPerAccount: 15,
    accountRegistrationEnabled: true,
    allowRegistrationBeforeConnect: true,
    emailVerificationEnabled: false,
    ...overrides
  };
}

describe("IrcSettingsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("shows an empty state instead of fetching when the container isn't running", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<IrcSettingsPanel appId={1} containerRunning={false} />);

    expect(
      screen.getByText("The container is not running, so its IRC settings can't be changed right now.")
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("lists existing operators and their roles", async () => {
    const operators: IrcOperator[] = [
      { username: "admin", role: "admin", knownRole: true },
      { username: "carol", role: "moderator", knownRole: true }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/irc/operators")) {
          return jsonResponse({ success: true, operators });
        }
        if (url.includes("/irc/settings")) {
          return jsonResponse({ success: true, settings: defaultSettings() });
        }
        return jsonResponse({ success: true, content: "" });
      })
    );

    render(<IrcSettingsPanel appId={1} containerRunning />);
    await userEvent.click(screen.getByRole("tab", { name: "Operators" }));

    await waitFor(() => {
      expect(screen.getByText("admin")).toBeInTheDocument();
    });
    const adminRow = screen.getByText("admin").closest(".wizard-row") as HTMLElement;
    const carolRow = screen.getByText("carol").closest(".wizard-row") as HTMLElement;
    expect(within(adminRow).getByText("Admin")).toBeInTheDocument();
    expect(within(carolRow).getByText("Moderator")).toBeInTheDocument();
  });

  test("adding an operator posts the form and re-renders the returned list", async () => {
    let postedBody: unknown = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/irc/operators") && init?.method === "POST") {
          postedBody = JSON.parse(init.body as string);
          return jsonResponse({
            success: true,
            operators: [{ username: "dave", role: "moderator", knownRole: true }]
          });
        }
        if (url.includes("/irc/operators")) {
          return jsonResponse({ success: true, operators: [] });
        }
        if (url.includes("/irc/settings")) {
          return jsonResponse({ success: true, settings: defaultSettings() });
        }
        return jsonResponse({ success: true, content: "" });
      })
    );

    render(<IrcSettingsPanel appId={1} containerRunning />);
    await userEvent.click(screen.getByRole("tab", { name: "Operators" }));

    await waitFor(() => {
      expect(screen.getByText("No operators configured yet.")).toBeInTheDocument();
    });

    await userEvent.type(screen.getByPlaceholderText("alice"), "dave");
    await userEvent.type(screen.getByPlaceholderText("At least 8 characters"), "supersecret123");
    await userEvent.click(screen.getByRole("button", { name: "Add Operator" }));

    await waitFor(() => {
      expect(screen.getByText("dave")).toBeInTheDocument();
    });
    expect(postedBody).toEqual({ username: "dave", password: "supersecret123", role: "moderator" });
  });

  test("removing an operator sends a DELETE for that username", async () => {
    let deletedUrl = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/irc/operators/") && init?.method === "DELETE") {
          deletedUrl = url;
          return jsonResponse({ success: true, operators: [] });
        }
        if (url.includes("/irc/operators")) {
          return jsonResponse({
            success: true,
            operators: [{ username: "admin", role: "admin", knownRole: true }]
          });
        }
        if (url.includes("/irc/settings")) {
          return jsonResponse({ success: true, settings: defaultSettings() });
        }
        return jsonResponse({ success: true, content: "" });
      })
    );

    render(<IrcSettingsPanel appId={1} containerRunning />);
    await userEvent.click(screen.getByRole("tab", { name: "Operators" }));

    await waitFor(() => {
      expect(screen.getByText("admin")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(screen.getByText("No operators configured yet.")).toBeInTheDocument();
    });
    expect(deletedUrl).toContain("/irc/operators/admin");
  });

  test("saving the MOTD sends its content and shows a confirmation", async () => {
    let putBody: unknown = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/irc/motd") && init?.method === "PUT") {
          putBody = JSON.parse(init.body as string);
          return jsonResponse({ success: true });
        }
        if (url.includes("/irc/motd")) {
          return jsonResponse({ success: true, content: "Welcome!" });
        }
        if (url.includes("/irc/settings")) {
          return jsonResponse({ success: true, settings: defaultSettings() });
        }
        return jsonResponse({ success: true, operators: [] });
      })
    );

    render(<IrcSettingsPanel appId={1} containerRunning />);
    await userEvent.click(screen.getByRole("tab", { name: "MOTD" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Welcome!")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Save MOTD" }));

    await waitFor(() => {
      expect(screen.getByText("MOTD saved.")).toBeInTheDocument();
    });
    expect(putBody).toEqual({ content: "Welcome!" });
  });

  test("loads general settings, including auto-join channels one per line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/irc/settings")) {
          return jsonResponse({
            success: true,
            settings: defaultSettings({ autoJoinChannels: ["#lobby", "#general"] })
          });
        }
        if (url.includes("/irc/operators")) {
          return jsonResponse({ success: true, operators: [] });
        }
        return jsonResponse({ success: true, content: "" });
      })
    );

    render(<IrcSettingsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("ExampleNet")).toBeInTheDocument();
    });
    expect(
      screen.getByDisplayValue("#lobby\n#general", { normalizer: (text) => text })
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("+ntC")).toBeInTheDocument();
  });

  test("saving settings sends the edited auto-join list split back into an array, and shows a confirmation", async () => {
    let putBody: unknown = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/irc/settings") && init?.method === "PUT") {
          putBody = JSON.parse(init.body as string);
          return jsonResponse({
            success: true,
            settings: defaultSettings({ autoJoinChannels: ["#lobby", "#welcome"] })
          });
        }
        if (url.includes("/irc/settings")) {
          return jsonResponse({ success: true, settings: defaultSettings() });
        }
        if (url.includes("/irc/operators")) {
          return jsonResponse({ success: true, operators: [] });
        }
        return jsonResponse({ success: true, content: "" });
      })
    );

    render(<IrcSettingsPanel appId={1} containerRunning />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("ExampleNet")).toBeInTheDocument();
    });

    const autoJoinField = screen.getByPlaceholderText("#lobby\n#general", {
      normalizer: (text) => text
    });
    await userEvent.clear(autoJoinField);
    await userEvent.type(autoJoinField, "#lobby{enter}#welcome");

    await userEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => {
      expect(screen.getByText("Settings saved.")).toBeInTheDocument();
    });
    expect((putBody as { autoJoinChannels: string[] }).autoJoinChannels).toEqual(["#lobby", "#welcome"]);
  });
});
