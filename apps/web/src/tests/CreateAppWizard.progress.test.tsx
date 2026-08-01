import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateAppWizard from "../components/CreateAppWizard";
import type { InstallProgress } from "../types/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

interface Captured {
  installIds: string[];
  streamUrls: string[];
  closed: number;
}

/**
 * A minimal EventSource stand-in — jsdom has none. It records the URL it was
 * opened with and lets a test push progress frames at will.
 */
function installEventSourceStub(captured: Captured) {
  const instances: Array<{ emit: (progress: InstallProgress) => void }> = [];

  class FakeEventSource {
    private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

    constructor(url: string) {
      captured.streamUrls.push(url);
      instances.push({
        emit: (progress) => {
          for (const listener of this.listeners.get("progress") ?? []) {
            listener({ data: JSON.stringify(progress) } as MessageEvent);
          }
        }
      });
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const existing = this.listeners.get(type) ?? [];
      existing.push(listener);
      this.listeners.set(type, existing);
    }

    close() {
      captured.closed += 1;
    }
  }

  vi.stubGlobal("EventSource", FakeEventSource);
  return instances;
}

function installFetchMock(captured: Captured, options: { fail?: boolean } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/environment/global") return jsonResponse(200, { variables: [] });
      if (url === "/api/integrations/github") return jsonResponse(200, { connected: false });
      if (url === "/api/github/installations")
        return jsonResponse(200, { configured: false, installations: [] });
      if (url === "/api/apps/wizard/brief") return jsonResponse(200, { domain: "x", brief: "b" });

      if (url === "/api/apps/wizard") {
        const headers = new Headers(init?.headers);
        captured.installIds.push(headers.get("X-Install-Id") ?? "");

        if (options.fail) {
          return jsonResponse(502, { success: false, message: "docker exploded" });
        }

        return jsonResponse(201, {
          success: true,
          message: "App created successfully.",
          app: {
            id: 1,
            name: "demo",
            containerName: "app-demo",
            image: "nginx:alpine",
            containerPort: 3000,
            domain: "demo.example.com",
            internalOnly: false,
            containerId: "c1",
            status: "running",
            routingReady: true,
            environmentVariableCount: 0,
            secretVariableCount: 0,
            storageMountCount: 0
          }
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    })
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Continue" })); // Source -> Basics
  await user.type(screen.getByLabelText("App name", { exact: false }), "demo");
  await user.type(screen.getByLabelText("Docker image", { exact: false }), "nginx:alpine");

  for (let step = 0; step < 5; step += 1) {
    await user.click(screen.getByRole("button", { name: "Continue" }));
  }

  await user.click(screen.getByRole("button", { name: "Create App" }));
}

describe("CreateAppWizard — install progress", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("opens the progress stream before posting, with a matching install id", async () => {
    const captured: Captured = { installIds: [], streamUrls: [], closed: 0 };
    installEventSourceStub(captured);
    installFetchMock(captured);

    const user = userEvent.setup();
    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillAndSubmit(user);

    await waitFor(() => expect(captured.installIds).toHaveLength(1));

    expect(captured.streamUrls).toHaveLength(1);
    const installId = captured.installIds[0];
    expect(installId).toBeTruthy();
    // The id in the stream URL and the POST header must be the same, or the
    // stream would be listening to a different install.
    expect(captured.streamUrls[0]).toBe(`/api/apps/wizard/install/${installId}/progress`);
  });

  test("renders live percentage from the stream", async () => {
    const captured: Captured = { installIds: [], streamUrls: [], closed: 0 };
    const sources = installEventSourceStub(captured);
    installFetchMock(captured);

    const user = userEvent.setup();
    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillAndSubmit(user);

    await waitFor(() => expect(sources.length).toBeGreaterThan(0));

    sources[0].emit({
      installId: "x",
      status: "running",
      percent: 62,
      currentService: "demo",
      services: [
        {
          name: "demo",
          stage: "pulling",
          percent: 62,
          detail: "Downloading image (620 MB of 1.0 GB)"
        }
      ],
      error: null,
      startedAt: "2026-08-01T00:00:00Z",
      finishedAt: null
    });

    expect(await screen.findByText("62%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "62");
    expect(screen.getByText(/620 MB of 1.0 GB/)).toBeInTheDocument();
  });

  test("closes the stream once the request settles", async () => {
    const captured: Captured = { installIds: [], streamUrls: [], closed: 0 };
    installEventSourceStub(captured);
    installFetchMock(captured);

    const user = userEvent.setup();
    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillAndSubmit(user);

    await waitFor(() => expect(captured.closed).toBeGreaterThan(0));
  });

  test("a failed install shows the error in the dialog", async () => {
    const captured: Captured = { installIds: [], streamUrls: [], closed: 0 };
    installEventSourceStub(captured);
    installFetchMock(captured, { fail: true });

    const user = userEvent.setup();
    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillAndSubmit(user);

    expect(await screen.findByText("Installation failed")).toBeInTheDocument();

    // Scoped to the dialog: the wizard's own Review-step error banner
    // carries the same message and role behind it, deliberately.
    const modal = document.querySelector(".install-progress-modal") as HTMLElement;
    expect(within(modal).getByRole("alert")).toHaveTextContent("docker exploded");
  });

  test("an install still completes when the browser has no EventSource at all", async () => {
    const captured: Captured = { installIds: [], streamUrls: [], closed: 0 };
    // No EventSource stub installed: opening the stream throws, which must
    // never take the install itself down.
    vi.stubGlobal("EventSource", undefined);
    installFetchMock(captured);

    const user = userEvent.setup();
    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillAndSubmit(user);

    expect(await screen.findByText("demo was created successfully.")).toBeInTheDocument();
    expect(captured.installIds).toHaveLength(1);
  });
});
