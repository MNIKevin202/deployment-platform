import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PlatformUpdateBanner from "../components/PlatformUpdateBanner";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type StatusOpts = {
  outcome?: "up-to-date" | "update-available" | "check-failed";
  state?: string;
  latestVersion?: string;
  updateNowAllowed?: boolean;
  requiresIncrementalUpgrade?: boolean;
  detail?: string | null;
  currentVersion?: string;
  pendingApply?: { targetVersion: string } | null;
};

function status(opts: StatusOpts) {
  const {
    outcome,
    state = "idle",
    latestVersion,
    updateNowAllowed = false,
    requiresIncrementalUpgrade = false,
    detail = null,
    currentVersion = "1.4.0",
    pendingApply = null
  } = opts;
  const result =
    outcome === "check-failed"
      ? { outcome, reason: "endpoint unavailable" }
      : outcome
        ? { outcome, latestVersion, requiresIncrementalUpgrade, rollbackSafe: true, requiresManualApproval: false }
        : null;
  return {
    success: true,
    currentVersion,
    status: outcome ? { lastCheckedAt: "2026-09-17T00:00:00.000Z", result } : null,
    state: { state, targetVersion: latestVersion ?? null, detail, updatedAt: "2026-09-17T00:00:00.000Z" },
    latestSuccessfulUpdate: null,
    updateNowAllowed,
    pendingApply
  };
}

/** A fetch mock that serves a SEQUENCE of /status responses ("reject" simulates
 *  the API being down during the container swap), a POST /apply, and /check. */
function mountFetch(statusSequence: (object | "reject")[], applyBody: Record<string, unknown> = { success: true, accepted: true, immediateTrigger: true, targetVersion: "1.5.0" }) {
  let idx = 0;
  let applyCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/platform/updates/status")) {
      const r = statusSequence[Math.min(idx, statusSequence.length - 1)];
      idx += 1;
      if (r === "reject") throw new Error("connection refused");
      return jsonResponse(r);
    }
    if (method === "POST" && url.endsWith("/api/platform/updates/apply")) {
      applyCalls += 1;
      return jsonResponse(applyBody, 202);
    }
    if (method === "POST" && url.endsWith("/api/platform/updates/check")) {
      return jsonResponse({ success: true });
    }
    throw new Error(`Unhandled fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { get calls() { return applyCalls; }, fetchMock };
}

describe("PlatformUpdateBanner", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("shows 'up to date' with a Check button", async () => {
    mountFetch([status({ outcome: "up-to-date", state: "idle" })]);
    render(<PlatformUpdateBanner />);
    await screen.findByText("ClovaForge is up to date");
    expect(screen.getByRole("button", { name: /Check for Updates/i })).toBeInTheDocument();
  });

  test("shows an available update and an enabled Update Now button", async () => {
    mountFetch([status({ outcome: "update-available", state: "update_available", latestVersion: "1.5.0", updateNowAllowed: true })]);
    render(<PlatformUpdateBanner />);
    await screen.findByText(/ClovaForge 1.5.0 is available/);
    expect(screen.getByRole("button", { name: "Update Now" })).toBeEnabled();
  });

  test("Update Now opens a confirmation modal with versions and verified checks", async () => {
    mountFetch([status({ outcome: "update-available", state: "update_available", latestVersion: "1.5.0", updateNowAllowed: true })]);
    render(<PlatformUpdateBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Update Now" }));
    await screen.findByText("ClovaForge Update");
    expect(screen.getByText("Signed release verified")).toBeInTheDocument();
    expect(screen.getByText("Compatible with this installation")).toBeInTheDocument();
    expect(screen.getByText("1.5.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install Update" })).toBeInTheDocument();
  });

  test("confirming the update triggers apply exactly once and shows progress", async () => {
    const h = mountFetch([
      status({ outcome: "update-available", state: "update_available", latestVersion: "1.5.0", updateNowAllowed: true }),
      status({ outcome: "update-available", state: "installing", latestVersion: "1.5.0", detail: "swapping containers" })
    ]);
    render(<PlatformUpdateBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Update Now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install Update" }));
    await screen.findByText("Installing ClovaForge…");
    expect(h.calls).toBe(1);
  });

  test("double-clicking Install Update fires apply only once", async () => {
    const h = mountFetch([
      status({ outcome: "update-available", state: "update_available", latestVersion: "1.5.0", updateNowAllowed: true }),
      status({ outcome: "update-available", state: "installing", latestVersion: "1.5.0" })
    ]);
    render(<PlatformUpdateBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Update Now" }));
    const install = await screen.findByRole("button", { name: "Install Update" });
    fireEvent.click(install);
    fireEvent.click(install);
    await screen.findByText("Installing ClovaForge…");
    expect(h.calls).toBe(1);
  });

  test("a scheduled-fallback apply (bridge unavailable) shows a 'queued' notice, not progress", async () => {
    mountFetch(
      [status({ outcome: "update-available", state: "update_available", latestVersion: "1.5.0", updateNowAllowed: true })],
      { success: true, accepted: true, immediateTrigger: false, fallback: "scheduled", targetVersion: "1.5.0", message: "Update to 1.5.0 queued — it will apply on the next scheduled check (within ~15 minutes)." }
    );
    render(<PlatformUpdateBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Update Now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install Update" }));
    await screen.findByText(/it will apply on the next scheduled check/i);
    expect(screen.queryByText("Installing ClovaForge…")).toBeNull();
  });

  test("tolerates the API restart: shows 'restarting' on a failed poll, not a failure", async () => {
    // Real timers: the hook polls every ~1.5s; a rejected poll = the API is
    // momentarily down during the swap → 'restarting', never a failure.
    mountFetch([
      status({ outcome: "update-available", state: "update_available", latestVersion: "1.5.0", updateNowAllowed: true }),
      status({ outcome: "update-available", state: "installing", latestVersion: "1.5.0" }),
      "reject"
    ]);
    render(<PlatformUpdateBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Update Now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install Update" }));
    await screen.findByText("Installing ClovaForge…");
    await screen.findByText("ClovaForge is restarting…", {}, { timeout: 4000 });
  });

  test("shows success once the durable state reports 'successful'", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });
    mountFetch([
      status({ outcome: "update-available", state: "update_available", latestVersion: "1.5.0", updateNowAllowed: true }),
      status({ outcome: "update-available", state: "installing", latestVersion: "1.5.0" }),
      status({ outcome: "up-to-date", state: "successful", currentVersion: "1.5.0" })
    ]);
    render(<PlatformUpdateBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Update Now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install Update" }));
    await screen.findByText("Installing ClovaForge…");
    await screen.findByText(/Updated successfully to 1.5.0/, {}, { timeout: 4000 });
  });

  test("rollback is shown as a restore, with a sanitized reason", async () => {
    mountFetch([status({ state: "rolled_back", detail: "migration_verify failed", currentVersion: "1.4.0" })]);
    render(<PlatformUpdateBanner />);
    await screen.findByText(/previous version restored/i);
    expect(screen.getByText(/running normally on 1.4.0/)).toBeInTheDocument();
  });

  test("manual intervention shows a strong warning", async () => {
    mountFetch([status({ state: "manual_intervention_required", detail: "breaking migration ran" })]);
    render(<PlatformUpdateBanner />);
    await screen.findByText(/needs manual recovery/i);
  });
});
