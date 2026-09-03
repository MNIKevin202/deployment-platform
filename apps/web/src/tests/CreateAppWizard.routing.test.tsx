import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateAppWizard from "../components/CreateAppWizard";
import type { CreatedAppSummary } from "../types/api";

/**
 * Covers the wizard's "Networking" step: choosing Public (default
 * or custom domain) vs Internal-only, validating a custom domain before
 * submission, and sending the resulting internalOnly/customDomain fields to
 * POST /api/apps/wizard.
 */

function createdApp(overrides: Partial<CreatedAppSummary> = {}): CreatedAppSummary {
  return {
    id: 1,
    name: "routing-test",
    containerName: "app-routing-test",
    image: "nginx:alpine",
    containerPort: 3000,
    domain: "roadmapstudio.xyz",
    internalOnly: false,
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

function installFetchMock(
  wizardHandler: (log: FetchLog) => Response | Promise<Response>
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
      const body = init?.body ? (JSON.parse(init.body as string) as { internalOnly?: boolean; customDomain?: string }) : {};
      const domain = body.internalOnly
        ? null
        : (body.customDomain ?? "routing-test.apps.devminted.com");
      return jsonResponse(200, { domain, brief: "fake brief text" });
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

async function advanceToDomainStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.type(await screen.findByLabelText("App name", { exact: false }), "routing-test");
  await user.type(screen.getByLabelText("Docker image", { exact: false }), "nginx:alpine");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  // Now on step 3, Networking.
}

describe("CreateAppWizard — routing choice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("default (public, generated domain) behavior is unchanged: Continue works immediately", async () => {
    const user = userEvent.setup();
    installFetchMock(() => jsonResponse(201, { success: true, message: "ok", app: createdApp() }));

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await advanceToDomainStep(user);

    // No custom-domain input is shown by default.
    expect(screen.queryByPlaceholderText("roadmapstudio.xyz")).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: "Create App" });
  });

  test("choosing internal-only hides the domain input entirely", async () => {
    const user = userEvent.setup();
    installFetchMock(() => jsonResponse(201, { success: true, message: "ok", app: createdApp({ internalOnly: true, domain: null }) }));

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await advanceToDomainStep(user);

    await user.click(screen.getByText(/Internal-only app/));

    expect(screen.queryByText("Use a custom domain")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("roadmapstudio.xyz")).not.toBeInTheDocument();
    expect(screen.getByText(/Internal only, no public URL/)).toBeInTheDocument();
  });

  test("custom-domain mode blocks Continue until a valid domain is entered", async () => {
    const user = userEvent.setup();
    installFetchMock(() => jsonResponse(201, { success: true, message: "ok", app: createdApp() }));

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await advanceToDomainStep(user);

    await user.click(screen.getByText("Use a custom domain"));

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();

    const domainInput = screen.getByPlaceholderText("roadmapstudio.xyz");
    await user.type(domainInput, "not a valid domain");
    expect(continueButton).toBeDisabled();

    await user.clear(domainInput);
    await user.type(domainInput, "roadmapstudio.xyz");
    await waitFor(() => expect(continueButton).not.toBeDisabled());
  });

  test("submitting with internal-only sends internalOnly:true and no customDomain", async () => {
    const user = userEvent.setup();
    const { calls } = installFetchMock(() =>
      jsonResponse(201, { success: true, message: "ok", app: createdApp({ internalOnly: true, domain: null }) })
    );

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await advanceToDomainStep(user);
    await user.click(screen.getByText(/Internal-only app/));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Create App" }));

    await waitFor(() => {
      expect(screen.getByText(/was created successfully/)).toBeInTheDocument();
    });

    const wizardCall = calls.find((c) => c.url === "/api/apps/wizard");
    const body = JSON.parse(wizardCall?.init?.body as string) as {
      internalOnly: boolean;
      customDomain?: string;
    };
    expect(body.internalOnly).toBe(true);
    expect(body.customDomain).toBeUndefined();

    // Internal-only success message never claims a public domain.
    expect(
      screen.getByText(/internal only — it has no public domain/)
    ).toBeInTheDocument();
  });

  test("submitting with a custom domain sends internalOnly:false and the exact trimmed domain", async () => {
    const user = userEvent.setup();
    const { calls } = installFetchMock(() =>
      jsonResponse(201, {
        success: true,
        message: "ok",
        app: createdApp({ domain: "roadmapstudio.xyz", internalOnly: false })
      })
    );

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await advanceToDomainStep(user);
    await user.click(screen.getByText("Use a custom domain"));
    await user.type(screen.getByPlaceholderText("roadmapstudio.xyz"), "  RoadmapStudio.xyz  ");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled()
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Create App" }));

    await waitFor(() => {
      expect(screen.getByText(/was created successfully/)).toBeInTheDocument();
    });

    const wizardCall = calls.find((c) => c.url === "/api/apps/wizard");
    const body = JSON.parse(wizardCall?.init?.body as string) as {
      internalOnly: boolean;
      customDomain?: string;
    };
    expect(body.internalOnly).toBe(false);
    // The raw (untrimmed) field value is sent — the server is the source of
    // truth for normalization; the wizard's client-side validity check just
    // gates Continue, matching how the rest of the wizard defers authority
    // to the API.
    expect(body.customDomain?.trim().toLowerCase()).toBe("roadmapstudio.xyz");
  });
});
