import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateAppWizard from "../components/CreateAppWizard";
import { APP_TEMPLATES } from "../lib/appTemplates";
import type { CreatedAppSummary } from "../types/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createdApp(overrides: Partial<CreatedAppSummary> = {}): CreatedAppSummary {
  return {
    id: 1,
    name: "postgres-abc123",
    containerName: "app-postgres-abc123",
    image: "postgres:16-alpine",
    containerPort: 5432,
    domain: null,
    internalOnly: true,
    containerId: "container-abc123",
    status: "running",
    routingReady: false,
    environmentVariableCount: 3,
    secretVariableCount: 1,
    storageMountCount: 1,
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

    if (url === "/api/environment/global") return jsonResponse(200, { variables: [] });
    if (url === "/api/integrations/github") return jsonResponse(200, { connected: false });
    if (url === "/api/apps/wizard") return wizardHandler({ url, init });

    throw new Error(`Unhandled fetch in test: ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return { calls };
}

const postgresGuided = APP_TEMPLATES.find((t) => t.id === "postgres-guided")!;

describe("CreateAppWizard — guided Postgres template", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("renders only username/password as freehand fields, with an auto-generated name", async () => {
    installFetchMock(() => jsonResponse(201, { success: true, message: "ok", app: createdApp() }));

    render(
      <CreateAppWizard
        open
        initialTemplate={postgresGuided}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    expect(await screen.findByLabelText("Database username", { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText("Database password", { exact: false })).toBeInTheDocument();

    // No stepper, no app-name field, no image/port fields anywhere.
    expect(screen.queryByText("Basics")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("App name", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Docker image", { exact: false })).not.toBeInTheDocument();
  });

  test("Create Database is disabled until both fields are valid", async () => {
    const user = userEvent.setup();
    installFetchMock(() => jsonResponse(201, { success: true, message: "ok", app: createdApp() }));

    render(
      <CreateAppWizard
        open
        initialTemplate={postgresGuided}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    const createButton = await screen.findByRole("button", { name: "Create Database" });
    expect(createButton).toBeDisabled();

    await user.type(screen.getByLabelText("Database username", { exact: false }), "app_user");
    expect(createButton).toBeDisabled(); // password still empty

    await user.type(screen.getByLabelText("Database password", { exact: false }), "short");
    expect(createButton).toBeDisabled(); // too short

    await user.type(screen.getByLabelText("Database password", { exact: false }), "1234");
    expect(createButton).toBeEnabled();
  });

  test("Generate fills a password and Show reveals it", async () => {
    const user = userEvent.setup();
    installFetchMock(() => jsonResponse(201, { success: true, message: "ok", app: createdApp() }));

    render(
      <CreateAppWizard
        open
        initialTemplate={postgresGuided}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    await screen.findByLabelText("Database password", { exact: false });
    await user.click(screen.getByRole("button", { name: "Generate" }));

    const passwordInput = screen.getByLabelText("Database password", { exact: false }) as HTMLInputElement;
    expect(passwordInput.value.length).toBeGreaterThanOrEqual(8);
    expect(passwordInput.type).toBe("text"); // Generate also reveals it

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(passwordInput.type).toBe("password");
  });

  test("submitting posts the auto-filled payload plus the typed username/password", async () => {
    const user = userEvent.setup();
    const { calls } = installFetchMock(() =>
      jsonResponse(201, { success: true, message: "ok", app: createdApp() })
    );

    render(
      <CreateAppWizard
        open
        initialTemplate={postgresGuided}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    await user.type(
      await screen.findByLabelText("Database username", { exact: false }),
      "app_user"
    );
    await user.type(
      screen.getByLabelText("Database password", { exact: false }),
      "correct-horse-battery"
    );
    await user.click(screen.getByRole("button", { name: "Create Database" }));

    await screen.findByText("postgres-abc123 was created successfully.");

    const wizardCall = calls.find((c) => c.url === "/api/apps/wizard");
    expect(wizardCall).toBeDefined();
    const body = JSON.parse(wizardCall!.init!.body as string) as {
      name: string;
      image: string;
      containerPort: number;
      internalOnly: boolean;
      environmentVariables: { key: string; value: string; isSecret: boolean }[];
    };

    expect(body.image).toBe("postgres:16-alpine");
    expect(body.containerPort).toBe(5432);
    expect(body.internalOnly).toBe(true);
    expect(body.name).toMatch(/^postgres-[0-9a-f]{6}$/);

    const byKey = Object.fromEntries(body.environmentVariables.map((v) => [v.key, v]));
    expect(byKey.POSTGRES_USER.value).toBe("app_user");
    expect(byKey.POSTGRES_USER.isSecret).toBe(false);
    expect(byKey.POSTGRES_PASSWORD.value).toBe("correct-horse-battery");
    expect(byKey.POSTGRES_PASSWORD.isSecret).toBe(true);
    expect(byKey.POSTGRES_DB.value).toBe("app");
  });

  test("the success screen offers to copy AI connection instructions", async () => {
    const user = userEvent.setup();
    installFetchMock(() => jsonResponse(201, { success: true, message: "ok", app: createdApp() }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });

    render(
      <CreateAppWizard
        open
        initialTemplate={postgresGuided}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    await user.type(
      await screen.findByLabelText("Database username", { exact: false }),
      "app_user"
    );
    await user.type(
      screen.getByLabelText("Database password", { exact: false }),
      "correct-horse-battery"
    );
    await user.click(screen.getByRole("button", { name: "Create Database" }));

    await screen.findByText("postgres-abc123 was created successfully.");

    await user.click(screen.getByRole("button", { name: "Copy AI Connection Instructions" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("app-postgres-abc123");
    expect(copiedText).toContain("5432");
    expect(copiedText).toContain("app_user");
    expect(copiedText).toContain("correct-horse-battery");
    expect(copiedText).toContain("postgresql://app_user:correct-horse-battery@app-postgres-abc123:5432/app");
    expect(copiedText.toLowerCase()).toContain("internal-only");

    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });
});
