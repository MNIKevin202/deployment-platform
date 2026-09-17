import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlatformUpdatesPanel from "../components/PlatformUpdatesPanel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SETTINGS = {
  success: true,
  currentVersion: "1.2.0",
  settings: { channel: "stable", policy: "notify_only", manifestBaseUrl: "https://example.com/d", maintenanceWindow: null },
  derivedUrls: { manifestUrl: "https://example.com/d/stable-latest/manifest.json", signatureUrl: "x" }
};

function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    currentVersion: "1.2.0",
    status: { lastCheckedAt: "2026-09-16T10:00:00.000Z", result: { outcome: "up-to-date" } },
    state: { state: "idle", targetVersion: null, detail: null, updatedAt: "2026-09-16T10:00:00.000Z" },
    latestSuccessfulUpdate: null,
    ...overrides
  };
}

function mountFetch(handlers: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    const handler = handlers[key] ?? handlers[url];
    if (!handler) throw new Error(`Unhandled fetch: ${key}`);
    return handler();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PlatformUpdatesPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("shows the current version and up-to-date state", async () => {
    mountFetch({
      "/api/platform/updates/settings": () => jsonResponse(SETTINGS),
      "/api/platform/updates/status": () => jsonResponse(statusBody()),
      "/api/platform/updates/history": () => jsonResponse({ success: true, history: [] })
    });
    render(<PlatformUpdatesPanel />);
    await screen.findByText("ClovaForge 1.2.0");
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    expect(screen.getByText(/latest release for the stable channel/i)).toBeInTheDocument();
  });

  test("offers 'Update now' only for a directly-installable update", async () => {
    mountFetch({
      "/api/platform/updates/settings": () => jsonResponse(SETTINGS),
      "/api/platform/updates/status": () =>
        jsonResponse(
          statusBody({
            status: {
              lastCheckedAt: "2026-09-16T10:00:00.000Z",
              result: { outcome: "update-available", latestVersion: "1.3.0", requiresIncrementalUpgrade: false, rollbackSafe: true }
            },
            state: { state: "update_available", targetVersion: "1.3.0", detail: null, updatedAt: "x" }
          })
        ),
      "/api/platform/updates/history": () => jsonResponse({ success: true, history: [] })
    });
    render(<PlatformUpdatesPanel />);
    await screen.findByText("Update available");
    expect(screen.getByRole("button", { name: /Update now to 1.3.0/ })).toBeInTheDocument();
  });

  test("hides 'Update now' when an incremental upgrade is required", async () => {
    mountFetch({
      "/api/platform/updates/settings": () => jsonResponse(SETTINGS),
      "/api/platform/updates/status": () =>
        jsonResponse(
          statusBody({
            status: {
              lastCheckedAt: "2026-09-16T10:00:00.000Z",
              result: { outcome: "update-available", latestVersion: "3.0.0", requiresIncrementalUpgrade: true }
            }
          })
        ),
      "/api/platform/updates/history": () => jsonResponse({ success: true, history: [] })
    });
    render(<PlatformUpdatesPanel />);
    await screen.findByText(/too old to jump straight here/i);
    expect(screen.queryByRole("button", { name: /Update now/ })).toBeNull();
  });

  test("changing the policy PUTs the new settings", async () => {
    const user = userEvent.setup();
    const fetchMock = mountFetch({
      "/api/platform/updates/settings": () => jsonResponse(SETTINGS),
      "/api/platform/updates/status": () => jsonResponse(statusBody()),
      "/api/platform/updates/history": () => jsonResponse({ success: true, history: [] }),
      "PUT /api/platform/updates/settings": () => jsonResponse({ success: true, settings: { ...SETTINGS.settings, policy: "automatic_patch" } })
    });
    render(<PlatformUpdatesPanel />);
    await screen.findByText("ClovaForge 1.2.0");
    await user.selectOptions(screen.getByLabelText("Update policy"), "automatic_patch");
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/platform/updates/settings" && (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(putCall).toBeTruthy();
      expect(JSON.parse((putCall![1] as RequestInit).body as string).policy).toBe("automatic_patch");
    });
  });

  test("renders update history newest-first with a result badge", async () => {
    mountFetch({
      "/api/platform/updates/settings": () => jsonResponse(SETTINGS),
      "/api/platform/updates/status": () => jsonResponse(statusBody()),
      "/api/platform/updates/history": () =>
        jsonResponse({
          success: true,
          history: [
            {
              id: 2,
              fromVersion: "1.1.0",
              toVersion: "1.2.0",
              trigger: "automatic",
              startedAt: "2026-09-15T00:00:00Z",
              finishedAt: "2026-09-15T00:05:00Z",
              result: "successful",
              healthResult: "passed",
              rollbackAttempted: false,
              diagnostic: null
            }
          ]
        })
    });
    render(<PlatformUpdatesPanel />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText(/1.1.0 → 1.2.0/)).toBeInTheDocument();
    expect(within(table).getByText("successful")).toBeInTheDocument();
  });
});
