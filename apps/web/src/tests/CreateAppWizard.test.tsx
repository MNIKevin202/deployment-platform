import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import CreateAppWizard from "../components/CreateAppWizard";
import type { CreatedAppSummary } from "../types/api";

/**
 * These tests exercise the exact bug reported against the live panel: a
 * single "Create App" click that, because the request was somehow delivered
 * to the API more than once (a real double submit, or — per the diagnosis —
 * a connection interrupted mid-request by the Caddy restart that route
 * reconciliation performs, then retried), resulted in the app actually being
 * created while the wizard displayed a misleading "already exists" error.
 *
 * The fix has two parts, both covered here:
 *   1. A ref-based submit lock so one user action can only ever produce one
 *      logical create attempt (covers double click, Enter-while-focused,
 *      and re-renders/StrictMode).
 *   2. A fresh Idempotency-Key per attempt, sent with the request (and
 *      reused only by this module's own bounded network-error retry), so
 *      even if the request IS delivered twice, the server replays the
 *      original result instead of erroring.
 */

function createdApp(overrides: Partial<CreatedAppSummary> = {}): CreatedAppSummary {
  return {
    id: 1,
    name: "routing-test",
    containerName: "app-routing-test",
    image: "nginx:alpine",
    containerPort: 3000,
    domain: "routing-test.apps.devminted.com",
    containerId: "container-abc123",
    status: "running",
    routingReady: true,
    environmentVariableCount: 0,
    secretVariableCount: 0,
    storageMountCount: 0,
    ...overrides
  };
}

interface FetchLog {
  url: string;
  init?: RequestInit;
}

/**
 * A router for the fixed set of endpoints CreateAppWizard calls as soon as
 * it opens (global env vars, GitHub connection status, the build brief) plus
 * the create endpoint itself, whose behavior each test controls via
 * `wizardHandler`.
 */
function installFetchMock(
  wizardHandler: (log: FetchLog) => Response | Promise<Response> | Promise<never>
) {
  const calls: FetchLog[] = [];

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url === "/api/environment/global") {
      return jsonResponse(200, { variables: [] });
    }
    if (url === "/api/integrations/github") {
      return jsonResponse(200, { connected: false });
    }
    if (url === "/api/apps/wizard/brief") {
      return jsonResponse(200, {
        domain: "routing-test.apps.devminted.com",
        brief: "fake brief text"
      });
    }
    if (url === "/api/apps/wizard") {
      return wizardHandler({ url, init });
    }

    throw new Error(`Unhandled fetch in test: ${url}`);
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

async function fillBasicsAndAdvanceToReview(user: ReturnType<typeof userEvent.setup>) {
  // Step 0 (Source): manual is selected by default and already valid.
  await user.click(await screen.findByRole("button", { name: "Continue" }));

  // Step 1 (Basics): app name + image are required. Each <label> also wraps
  // its helper <small> text, so an exact match on just the visible field
  // label would fail — match the label as a substring instead.
  await user.type(
    await screen.findByLabelText("App name", { exact: false }),
    "routing-test"
  );
  await user.type(
    screen.getByLabelText("Docker image", { exact: false }),
    "nginx:alpine"
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));

  // Steps 2-4 (Runtime, Environment, Storage) all have valid defaults.
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(await screen.findByRole("button", { name: "Continue" }));

  // Step 5 (Domain & Networking) triggers the build-brief fetch and is
  // always valid.
  await user.click(await screen.findByRole("button", { name: "Continue" }));

  // Now on step 6, Review & Create.
  await screen.findByRole("button", { name: "Create App" });
}

describe("CreateAppWizard — single-submit and idempotent create", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("one click causes exactly one request", async () => {
    const user = userEvent.setup();
    const { calls } = installFetchMock(() => jsonResponse(201, { success: true, message: "ok", app: createdApp() }));
    const onCreated = vi.fn();

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={onCreated} />);
    await fillBasicsAndAdvanceToReview(user);

    await user.click(screen.getByRole("button", { name: "Create App" }));

    await waitFor(() => {
      expect(screen.getByText(/was created successfully/)).toBeInTheDocument();
    });

    const wizardCalls = calls.filter((c) => c.url === "/api/apps/wizard");
    expect(wizardCalls).toHaveLength(1);
  });

  test("double click causes exactly one request", async () => {
    const user = userEvent.setup();
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });

    const { calls } = installFetchMock(() => pending);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillBasicsAndAdvanceToReview(user);

    const button = screen.getByRole("button", { name: "Create App" });
    // Two rapid clicks on the same button, before any response resolves.
    await user.click(button);
    await user.click(button);

    resolveFetch(jsonResponse(201, { success: true, message: "ok", app: createdApp() }));

    await waitFor(() => {
      expect(screen.getByText(/was created successfully/)).toBeInTheDocument();
    });

    expect(calls.filter((c) => c.url === "/api/apps/wizard")).toHaveLength(1);
  });

  test("pressing Enter on the focused Create App button does not add a second request", async () => {
    const user = userEvent.setup();
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const { calls } = installFetchMock(() => pending);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillBasicsAndAdvanceToReview(user);

    const button = screen.getByRole("button", { name: "Create App" });
    button.focus();
    await user.click(button);
    // A native focused <button> fires a click on Enter — this exercises
    // that same path through the one shared submit handler.
    await user.keyboard("{Enter}");

    resolveFetch(jsonResponse(201, { success: true, message: "ok", app: createdApp() }));

    await waitFor(() => {
      expect(screen.getByText(/was created successfully/)).toBeInTheDocument();
    });

    expect(calls.filter((c) => c.url === "/api/apps/wizard")).toHaveLength(1);
  });

  test("remounting under StrictMode does not itself fire a request, and a single click after still fires exactly one", async () => {
    const user = userEvent.setup();
    const { calls } = installFetchMock(() => jsonResponse(201, { success: true, message: "ok", app: createdApp() }));

    render(
      <StrictMode>
        <CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />
      </StrictMode>
    );

    // StrictMode double-invokes effects on mount; nothing should have hit
    // the create endpoint merely from mounting/opening.
    expect(calls.filter((c) => c.url === "/api/apps/wizard")).toHaveLength(0);

    await fillBasicsAndAdvanceToReview(user);
    await user.click(screen.getByRole("button", { name: "Create App" }));

    await waitFor(() => {
      expect(screen.getByText(/was created successfully/)).toBeInTheDocument();
    });

    expect(calls.filter((c) => c.url === "/api/apps/wizard")).toHaveLength(1);
  });

  test("a slow (simulated 40s) create stays single-submit: the button is disabled the whole time", async () => {
    const user = userEvent.setup();
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const { calls } = installFetchMock(() => pending);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillBasicsAndAdvanceToReview(user);

    const button = screen.getByRole("button", { name: "Create App" });
    await user.click(button);

    // Still "creating" long after a normal click would have resolved —
    // simulates the ~40 second real create. The button must stay disabled
    // and further clicks must not add requests.
    await waitFor(() => expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Creating..." }));
    await user.click(screen.getByRole("button", { name: "Creating..." }));

    resolveFetch(jsonResponse(201, { success: true, message: "ok", app: createdApp() }));

    await waitFor(() => {
      expect(screen.getByText(/was created successfully/)).toBeInTheDocument();
    });

    expect(calls.filter((c) => c.url === "/api/apps/wizard")).toHaveLength(1);
  });

  test("a network-level failure (connection dropped mid-request) safely retries with the same Idempotency-Key and surfaces the success", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    let seenKeys: Array<string | null> = [];

    const { calls } = installFetchMock(({ init }) => {
      attempt += 1;
      seenKeys.push((init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? null);

      if (attempt === 1) {
        // The connection was interrupted before any response was received —
        // this is what Caddy restarting mid-request looks like to fetch().
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return jsonResponse(201, { success: true, message: "ok", app: createdApp() });
    });

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillBasicsAndAdvanceToReview(user);

    await user.click(screen.getByRole("button", { name: "Create App" }));

    await waitFor(
      () => {
        expect(screen.getByText(/was created successfully/)).toBeInTheDocument();
      },
      { timeout: 5000 }
    );

    // Never shows an error after the eventual success.
    expect(screen.queryByRole("alert")).toBeNull();

    const wizardCalls = calls.filter((c) => c.url === "/api/apps/wizard");
    expect(wizardCalls).toHaveLength(2);
    expect(seenKeys[0]).toBeTruthy();
    expect(seenKeys[1]).toBe(seenKeys[0]);
  }, 10000);

  test("modal reaches the success view (never shows an error) and its close-and-refresh path fires exactly once", async () => {
    const user = userEvent.setup();
    installFetchMock(() => jsonResponse(201, { success: true, message: "ok", app: createdApp({ name: "routing-test" }) }));
    const onCreated = vi.fn();

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={onCreated} />);
    await fillBasicsAndAdvanceToReview(user);
    await user.click(screen.getByRole("button", { name: "Create App" }));

    await waitFor(() => {
      expect(screen.getByText("routing-test was created successfully.")).toBeInTheDocument();
    });
    expect(screen.queryByText(/already exists/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "View App" }));

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: "routing-test" }));
  });

  test("a real creation failure re-enables the button and shows the error, with no app created", async () => {
    const user = userEvent.setup();
    installFetchMock(() =>
      jsonResponse(409, { success: false, message: 'An app named "routing-test" already exists' })
    );

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillBasicsAndAdvanceToReview(user);
    await user.click(screen.getByRole("button", { name: "Create App" }));

    await waitFor(() => {
      expect(screen.getByText('An app named "routing-test" already exists')).toBeInTheDocument();
    });

    const button = screen.getByRole("button", { name: "Create App" });
    expect(button).not.toBeDisabled();
  });
});
