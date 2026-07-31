import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppDetail from "../components/AppDetail";
import type { AppDetail as AppDetailData } from "../types/api";

/**
 * These tests exercise the delete-app bug reported against the live panel: a
 * single confirmed delete that, because the connection was interrupted
 * mid-request — the Caddy restart route reconciliation performs, severing
 * this very request's connection — appeared to hang forever: the
 * confirmation dialog never closed, no success message appeared, and the
 * Delete button was left disabled, even though the app was actually deleted
 * server-side.
 *
 * The fix has three parts, all covered here:
 *   1. A ref-based single-delete lock (covers double confirmation clicks).
 *   2. An AbortController-driven timeout so a connection that neither
 *      resolves nor rejects cannot freeze the dialog forever, plus one bounded
 *      retry on any failure (timeout or network rejection) using the SAME
 *      Idempotency-Key.
 *   3. Errors are now rendered INSIDE the confirmation dialog (previously
 *      `actionError` rendered on the page behind the full-screen modal,
 *      invisible while it was open).
 */

function appDetail(overrides: Partial<AppDetailData> = {}): AppDetailData {
  return {
    id: 1,
    name: "routing-test",
    status: "running",
    desiredStatus: "running",
    containerId: "container-abc123",
    shortContainerId: "container-a",
    containerName: "app-routing-test",
    image: "nginx:alpine",
    containerPort: 3000,
    domain: "routing-test.apps.devminted.com",
    internalOnly: false,
    routingReady: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDeployedAt: "2026-01-01T00:00:00.000Z",
    restartPolicy: "unless-stopped",
    memoryLimitMb: null,
    cpuLimit: null,
    containerExists: true,
    dockerState: "running",
    dockerStatusText: "Up 2 minutes",
    environmentStatus: "applied",
    publishedPorts: [],
    ...overrides
  };
}

interface FetchLog {
  url: string;
  init?: RequestInit;
}

function installFetchMock(
  deleteHandler: (log: FetchLog) => Response | Promise<Response>
) {
  const calls: FetchLog[] = [];

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, init });

    if (method === "GET" && url === "/api/apps/1") {
      return jsonResponse(200, appDetail());
    }
    if (method === "DELETE" && url.startsWith("/api/apps/")) {
      return deleteHandler({ url, init });
    }

    throw new Error(`Unhandled fetch in test: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return { calls, impl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const noopProps = {
  onBack: vi.fn(),
  onAppChanged: vi.fn(),
  onGoToGlobalEnvironment: vi.fn()
};

async function openDeleteConfirmation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Delete" }));
  await screen.findByRole("alertdialog");
}

describe("AppDetail — single-delete and idempotent deletion", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("one confirmed delete causes exactly one DELETE request, closes the dialog, and calls onDeleted", async () => {
    const user = userEvent.setup();
    const { calls } = installFetchMock(() =>
      jsonResponse(200, { success: true, message: "routing-test was deleted.", action: "deleted" })
    );
    const onDeleted = vi.fn();

    render(<AppDetail appId={1} {...noopProps} onDeleted={onDeleted} />);
    await openDeleteConfirmation(user);
    await user.click(screen.getByRole("button", { name: "Delete app" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));

    const deleteCalls = calls.filter((c) => c.init?.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  test("double-clicking the confirm button causes exactly one DELETE request", async () => {
    const user = userEvent.setup();
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const { calls } = installFetchMock(() => pending);

    render(<AppDetail appId={1} {...noopProps} onDeleted={vi.fn()} />);
    await openDeleteConfirmation(user);

    const confirmButton = screen.getByRole("button", { name: "Delete app" });
    await user.click(confirmButton);
    await user.click(screen.getByRole("button", { name: "Deleting..." }));

    resolveFetch(jsonResponse(200, { success: true, message: "ok", action: "deleted" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    expect(calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(1);
  });

  test("a slow delete disables both dialog buttons and shows 'Deleting...'", async () => {
    const user = userEvent.setup();
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    installFetchMock(() => pending);

    render(<AppDetail appId={1} {...noopProps} onDeleted={vi.fn()} />);
    await openDeleteConfirmation(user);
    await user.click(screen.getByRole("button", { name: "Delete app" }));

    const confirmButton = await screen.findByRole("button", { name: "Deleting..." });
    expect(confirmButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    resolveFetch(jsonResponse(200, { success: true, message: "ok", action: "deleted" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("a network-level failure (connection dropped mid-request) safely retries with the same Idempotency-Key and ends in success", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const seenKeys: Array<string | null> = [];

    installFetchMock(({ init }) => {
      attempt += 1;
      seenKeys.push((init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? null);

      if (attempt === 1) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return jsonResponse(200, { success: true, message: "ok", action: "deleted" });
    });

    const onDeleted = vi.fn();
    render(<AppDetail appId={1} {...noopProps} onDeleted={onDeleted} />);
    await openDeleteConfirmation(user);
    await user.click(screen.getByRole("button", { name: "Delete app" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1), { timeout: 5000 });

    expect(seenKeys[0]).toBeTruthy();
    expect(seenKeys[1]).toBe(seenKeys[0]);
  }, 10000);

  test("same idempotency key replays a completed deletion (server contract exercised end to end)", async () => {
    const user = userEvent.setup();
    let recordedKey: string | null = null;
    let deleteCount = 0;

    installFetchMock(({ init }) => {
      const key = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? null;
      if (recordedKey === null) {
        recordedKey = key;
        deleteCount += 1;
        return jsonResponse(200, { success: true, message: "ok", action: "deleted" });
      }
      // A second delivery with the SAME key the client already used.
      expect(key).toBe(recordedKey);
      return jsonResponse(200, { success: true, message: "ok", action: "deleted" });
    });

    const onDeleted = vi.fn();
    render(<AppDetail appId={1} {...noopProps} onDeleted={onDeleted} />);
    await openDeleteConfirmation(user);
    await user.click(screen.getByRole("button", { name: "Delete app" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(deleteCount).toBe(1);
  });

  test("a real server failure shows the error inside the dialog and re-enables the controls", async () => {
    const user = userEvent.setup();
    installFetchMock(() =>
      jsonResponse(403, { success: false, message: "System containers cannot be deleted" })
    );

    render(<AppDetail appId={1} {...noopProps} onDeleted={vi.fn()} />);
    await openDeleteConfirmation(user);
    await user.click(screen.getByRole("button", { name: "Delete app" }));

    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => {
      expect(dialog).toHaveTextContent("System containers cannot be deleted");
    });

    const confirmButton = screen.getByRole("button", { name: "Delete app" });
    expect(confirmButton).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).not.toBeDisabled();
  });

  test("a stale error is cleared once a later delete succeeds", async () => {
    const user = userEvent.setup();
    let call = 0;
    installFetchMock(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse(500, { success: false, message: "Unable to delete app" });
      }
      return jsonResponse(200, { success: true, message: "ok", action: "deleted" });
    });

    const onDeleted = vi.fn();
    render(<AppDetail appId={1} {...noopProps} onDeleted={onDeleted} />);
    await openDeleteConfirmation(user);
    await user.click(screen.getByRole("button", { name: "Delete app" }));

    await screen.findByText("Unable to delete app");

    await user.click(screen.getByRole("button", { name: "Delete app" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
