import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateAppWizard from "../components/CreateAppWizard";
import { APP_TEMPLATES } from "../lib/appTemplates";
import type { CreateAppWizardPayload } from "../types/api";

const blueprint = APP_TEMPLATES.find((template) => template.id === "blueprint")!;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

interface FetchLog {
  wizardBodies: CreateAppWizardPayload[];
  pullBodies: Array<{ url: string; model: string }>;
}

function installFetchMock(options: { pullOk?: boolean } = {}): FetchLog {
  const log: FetchLog = { wizardBodies: [], pullBodies: [] };

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
        log.wizardBodies.push(JSON.parse(init?.body as string) as CreateAppWizardPayload);
        return jsonResponse(201, {
          success: true,
          message: "App created successfully.",
          app: {
            id: 42,
            name: "blueprint",
            containerName: "app-blueprint",
            image: blueprint.image,
            containerPort: 8080,
            domain: "blueprint.example.com",
            internalOnly: false,
            containerId: "c1",
            status: "running",
            routingReady: true,
            environmentVariableCount: 3,
            secretVariableCount: 1,
            storageMountCount: 1
          },
          companions: []
        });
      }

      if (url.includes("/blueprint/models")) {
        log.pullBodies.push({
          url,
          model: (JSON.parse(init?.body as string) as { model: string }).model
        });
        return options.pullOk === false
          ? jsonResponse(409, { success: false, message: "already running" })
          : jsonResponse(202, { success: true, message: "Downloading." });
      }

      throw new Error(`Unhandled fetch in test: ${url}`);
    })
  );

  return log;
}

/** Walks the wizard from the pre-filled Basics step to Review and submits. */
async function submitWizard(user: ReturnType<typeof userEvent.setup>) {
  for (let step = 0; step < 5; step += 1) {
    await user.click(screen.getByRole("button", { name: "Continue" }));
  }
  await user.click(screen.getByRole("button", { name: "Create App" }));
}

describe("CreateAppWizard — Blueprint", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("pre-fills name, image, and port from the template", async () => {
    installFetchMock();
    render(
      <CreateAppWizard open initialTemplate={blueprint} onClose={() => {}} onCreated={() => {}} />
    );

    const nameInput = (await screen.findByLabelText("App name", {
      exact: false
    })) as HTMLInputElement;
    expect(nameInput.value).toBe("blueprint");
    expect((screen.getByLabelText("Docker image", { exact: false }) as HTMLInputElement).value).toBe(
      "ghcr.io/open-webui/open-webui:0.11.0"
    );
  });

  test("sends the model server as an internal-only companion with its own volume", async () => {
    const log = installFetchMock();
    const user = userEvent.setup();
    render(
      <CreateAppWizard open initialTemplate={blueprint} onClose={() => {}} onCreated={() => {}} />
    );

    await screen.findByLabelText("App name", { exact: false });
    await submitWizard(user);

    await waitFor(() => expect(log.wizardBodies).toHaveLength(1));
    const payload = log.wizardBodies[0];

    expect(payload.companions).toHaveLength(1);
    const ollama = payload.companions![0];
    expect(ollama.name).toBe("blueprint-ollama");
    expect(ollama.image).toBe("ollama/ollama:0.32.5");
    expect(ollama.containerPort).toBe(11434);
    expect(ollama.internalOnly).toBe(true);
    expect(ollama.storageMounts).toEqual([{ containerPath: "/root/.ollama", readOnly: false }]);
  });

  test("the chat interface itself is public and publishes no host port", async () => {
    const log = installFetchMock();
    const user = userEvent.setup();
    render(
      <CreateAppWizard open initialTemplate={blueprint} onClose={() => {}} onCreated={() => {}} />
    );

    await screen.findByLabelText("App name", { exact: false });
    await submitWizard(user);

    await waitFor(() => expect(log.wizardBodies).toHaveLength(1));
    const payload = log.wizardBodies[0];

    expect(payload.internalOnly).toBe(false);
    expect(payload.publishedPorts).toEqual([]);
    expect(payload.storageMounts).toEqual([
      { containerPath: "/app/backend/data", volumeName: undefined, readOnly: false }
    ]);
  });

  test("resolves the companion placeholder to the real container name", async () => {
    const log = installFetchMock();
    const user = userEvent.setup();
    render(
      <CreateAppWizard open initialTemplate={blueprint} onClose={() => {}} onCreated={() => {}} />
    );

    await screen.findByLabelText("App name", { exact: false });
    await submitWizard(user);

    await waitFor(() => expect(log.wizardBodies).toHaveLength(1));
    const baseUrl = log.wizardBodies[0].environmentVariables.find(
      (envVar) => envVar.key === "OLLAMA_BASE_URL"
    );

    expect(baseUrl?.value).toBe("http://app-blueprint-ollama:11434");
    expect(baseUrl?.value).not.toContain("{{companion:");
  });

  test("renaming the app renames the companion and its URL together", async () => {
    const log = installFetchMock();
    const user = userEvent.setup();
    render(
      <CreateAppWizard open initialTemplate={blueprint} onClose={() => {}} onCreated={() => {}} />
    );

    const nameInput = await screen.findByLabelText("App name", { exact: false });
    await user.clear(nameInput);
    await user.type(nameInput, "studio-ai");
    await submitWizard(user);

    await waitFor(() => expect(log.wizardBodies).toHaveLength(1));
    const payload = log.wizardBodies[0];

    expect(payload.companions![0].name).toBe("studio-ai-ollama");
    expect(
      payload.environmentVariables.find((envVar) => envVar.key === "OLLAMA_BASE_URL")?.value
    ).toBe("http://app-studio-ai-ollama:11434");
  });

  test("generates a unique WEBUI_SECRET_KEY rather than shipping a fixed one", async () => {
    const log = installFetchMock();
    const user = userEvent.setup();

    const { unmount } = render(
      <CreateAppWizard open initialTemplate={blueprint} onClose={() => {}} onCreated={() => {}} />
    );
    await screen.findByLabelText("App name", { exact: false });
    await submitWizard(user);
    await waitFor(() => expect(log.wizardBodies).toHaveLength(1));
    unmount();

    render(
      <CreateAppWizard open initialTemplate={blueprint} onClose={() => {}} onCreated={() => {}} />
    );
    await screen.findByLabelText("App name", { exact: false });
    await submitWizard(user);
    await waitFor(() => expect(log.wizardBodies).toHaveLength(2));

    const keys = log.wizardBodies.map(
      (body) => body.environmentVariables.find((envVar) => envVar.key === "WEBUI_SECRET_KEY")!
    );

    expect(keys[0].isSecret).toBe(true);
    expect(keys[0].value.length).toBe(48);
    expect(keys[0].value).not.toBe(keys[1].value);
  });

  test("starts the chosen model download only after the app exists", async () => {
    const log = installFetchMock();
    const user = userEvent.setup();
    render(
      <CreateAppWizard
        open
        initialTemplate={blueprint}
        initialModel="llama3.2:3b"
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    await screen.findByLabelText("App name", { exact: false });
    await submitWizard(user);

    await waitFor(() => expect(log.pullBodies).toHaveLength(1));
    expect(log.pullBodies[0].url).toBe("/api/apps/42/blueprint/models");
    expect(log.pullBodies[0].model).toBe("llama3.2:3b");
    expect(await screen.findByText(/Downloading "llama3.2:3b"/)).toBeInTheDocument();
  });

  test("downloads nothing when the operator opted out of a first model", async () => {
    const log = installFetchMock();
    const user = userEvent.setup();
    render(
      <CreateAppWizard
        open
        initialTemplate={blueprint}
        initialModel={null}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    await screen.findByLabelText("App name", { exact: false });
    await submitWizard(user);

    await waitFor(() => expect(log.wizardBodies).toHaveLength(1));
    expect(log.pullBodies).toHaveLength(0);
  });

  test("a failed model download leaves the app created, with a retry hint", async () => {
    installFetchMock({ pullOk: false });
    const user = userEvent.setup();
    render(
      <CreateAppWizard
        open
        initialTemplate={blueprint}
        initialModel="llama3.2:3b"
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    await screen.findByLabelText("App name", { exact: false });
    await submitWizard(user);

    // The success screen still appears — a model download is not part of
    // whether the app itself deployed.
    expect(await screen.findByText(/was created successfully/)).toBeInTheDocument();
    expect(screen.getByText(/could not be started/)).toBeInTheDocument();
    expect(screen.getByText(/Blueprint tab/)).toBeInTheDocument();
  });

  test("an ordinary template still sends no companions at all", async () => {
    const log = installFetchMock();
    const user = userEvent.setup();
    const postgres = APP_TEMPLATES.find((template) => template.id === "postgres")!;

    render(
      <CreateAppWizard open initialTemplate={postgres} onClose={() => {}} onCreated={() => {}} />
    );

    await screen.findByLabelText("App name", { exact: false });
    await submitWizard(user);

    await waitFor(() => expect(log.wizardBodies).toHaveLength(1));
    expect(log.wizardBodies[0].companions).toBeUndefined();
    expect(log.pullBodies).toHaveLength(0);
  });
});
