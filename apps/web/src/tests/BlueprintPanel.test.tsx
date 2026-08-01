import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BlueprintPanel from "../components/BlueprintPanel";
import type { BlueprintStatus } from "../types/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function defaultStatus(overrides: Partial<BlueprintStatus> = {}): BlueprintStatus {
  return {
    webRunning: true,
    webDomain: "blueprint.example.com",
    modelServerName: "app-blueprint-ollama",
    modelServerRunning: true,
    modelServerReachable: true,
    modelServerUrl: "http://app-blueprint-ollama:11434",
    version: "0.32.5",
    models: [
      {
        name: "llama3.2:3b",
        size: 2019393189,
        modifiedAt: "2026-07-31T10:00:00Z",
        parameterSize: "3.2B",
        quantization: "Q4_K_M"
      }
    ],
    modelStorageBytes: 2019393189,
    modelError: null,
    pull: null,
    ...overrides
  };
}

interface Calls {
  posts: Array<{ model: string }>;
  deletes: Array<{ model: string }>;
}

function stubFetch(status: BlueprintStatus, options: { postStatus?: number } = {}): Calls {
  const calls: Calls = { posts: [], deletes: [] };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/blueprint/status")) {
        return jsonResponse({ success: true, status });
      }

      if (url.endsWith("/blueprint/models") && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { model: string };
        calls.posts.push(body);
        return options.postStatus === 409
          ? jsonResponse(
              { success: false, message: "A download of \"x\" is already running." },
              409
            )
          : jsonResponse({ success: true, message: "Downloading." }, 202);
      }

      if (url.endsWith("/blueprint/models") && init?.method === "DELETE") {
        calls.deletes.push(JSON.parse(init.body as string) as { model: string });
        return jsonResponse({ success: true, message: "Model deleted." });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    })
  );

  return calls;
}

describe("BlueprintPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("says nothing can be managed while the container is stopped", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<BlueprintPanel appId={1} containerRunning={false} />);

    expect(
      screen.getByText("The container is not running, so Blueprint can't be managed right now.")
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("shows both service statuses, the model list, and storage used", async () => {
    stubFetch(defaultStatus());
    render(<BlueprintPanel appId={1} containerRunning />);

    await waitFor(() => expect(screen.getByText("llama3.2:3b")).toBeInTheDocument());

    expect(screen.getAllByText("Running").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Ollama 0.32.5/)).toBeInTheDocument();
    expect(screen.getByText("1.9 GB")).toBeInTheDocument();
    expect(screen.getByText(/3.2B/)).toBeInTheDocument();
  });

  test("links to the public domain and shows the private model-server URL", async () => {
    stubFetch(defaultStatus());
    render(<BlueprintPanel appId={1} containerRunning />);

    const open = await screen.findByRole("link", { name: "Open Blueprint" });
    expect(open).toHaveAttribute("href", "https://blueprint.example.com");

    // The model server is addressed by its internal container name only —
    // never a public host.
    expect(screen.getByText("http://app-blueprint-ollama:11434")).toBeInTheDocument();
    expect(screen.getByText(/private, not on the internet/i)).toBeInTheDocument();
  });

  test("always states the CPU-only expectation", async () => {
    stubFetch(defaultStatus());
    render(<BlueprintPanel appId={1} containerRunning />);

    expect(
      await screen.findByText(/runs AI models on your VPS CPU/)
    ).toBeInTheDocument();
  });

  test("warns when no model is installed yet", async () => {
    stubFetch(defaultStatus({ models: [], modelStorageBytes: 0 }));
    render(<BlueprintPanel appId={1} containerRunning />);

    expect(
      await screen.findByText(/No models are installed yet/)
    ).toBeInTheDocument();
  });

  test("downloading a model posts the selected identifier", async () => {
    const calls = stubFetch(defaultStatus());
    render(<BlueprintPanel appId={1} containerRunning />);

    await waitFor(() => expect(screen.getByText("llama3.2:3b")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Download model" }));

    await waitFor(() => expect(calls.posts).toHaveLength(1));
    expect(calls.posts[0].model).toBe("llama3.2:3b");
  });

  test("a custom model name can be typed instead of picking from the list", async () => {
    const calls = stubFetch(defaultStatus());
    render(<BlueprintPanel appId={1} containerRunning />);

    await waitFor(() => expect(screen.getByText("llama3.2:3b")).toBeInTheDocument());
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Enter another model name/ })
    );
    await userEvent.type(screen.getByPlaceholderText("llama3.2:3b"), "qwen3:1.7b");
    await userEvent.click(screen.getByRole("button", { name: "Download model" }));

    await waitFor(() => expect(calls.posts).toHaveLength(1));
    expect(calls.posts[0].model).toBe("qwen3:1.7b");
  });

  test("surfaces a refused duplicate download instead of silently retrying", async () => {
    stubFetch(defaultStatus(), { postStatus: 409 });
    render(<BlueprintPanel appId={1} containerRunning />);

    await waitFor(() => expect(screen.getByText("llama3.2:3b")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Download model" }));

    expect(await screen.findByText(/already running/)).toBeInTheDocument();
  });

  test("shows live progress and disables the button while a pull runs", async () => {
    stubFetch(
      defaultStatus({
        pull: {
          model: "llama3.1:8b",
          status: "running",
          detail: "downloading",
          percent: 42,
          startedAt: "2026-07-31T10:00:00Z",
          finishedAt: null,
          error: null
        }
      })
    );
    render(<BlueprintPanel appId={1} containerRunning />);

    expect(await screen.findByText(/downloading/)).toBeInTheDocument();
    expect(screen.getByText(/42%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download in progress…" })).toBeDisabled();
  });

  test("offers a retry after a failed download and explains why it failed", async () => {
    stubFetch(
      defaultStatus({
        pull: {
          model: "nope:1b",
          status: "failed",
          detail: "Download failed.",
          percent: null,
          startedAt: "2026-07-31T10:00:00Z",
          finishedAt: "2026-07-31T10:01:00Z",
          error: "model not found"
        }
      })
    );
    render(<BlueprintPanel appId={1} containerRunning />);

    expect(await screen.findByText(/model not found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry download" })).toBeEnabled();
  });

  test("deleting a model asks for confirmation first, then sends the request", async () => {
    const calls = stubFetch(defaultStatus());
    render(<BlueprintPanel appId={1} containerRunning />);

    await waitFor(() => expect(screen.getByText("llama3.2:3b")).toBeInTheDocument());

    const row = screen.getByText("llama3.2:3b").closest(".wizard-row") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Delete" }));

    expect(screen.getByText(/Delete "llama3.2:3b" from the model server/)).toBeInTheDocument();
    expect(calls.deletes).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Delete Model" }));

    await waitFor(() => expect(calls.deletes).toHaveLength(1));
    expect(calls.deletes[0].model).toBe("llama3.2:3b");
  });

  test("cannot start a download while the model server is stopped", async () => {
    stubFetch(
      defaultStatus({ modelServerRunning: false, modelServerReachable: false, models: [] })
    );
    render(<BlueprintPanel appId={1} containerRunning />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Download model" })).toBeDisabled()
    );
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  test("shows the model-server error when one is reported", async () => {
    stubFetch(defaultStatus({ modelError: "Unable to reach the model server: timeout" }));
    render(<BlueprintPanel appId={1} containerRunning />);

    expect(await screen.findByText(/Unable to reach the model server/)).toBeInTheDocument();
  });
});
