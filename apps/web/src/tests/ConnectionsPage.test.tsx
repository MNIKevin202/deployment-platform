import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConnectionsPage from "../pages/ConnectionsPage";
import type { MaskedDatabaseConnection } from "../types/api";

function connection(
  overrides: Partial<MaskedDatabaseConnection> = {}
): MaskedDatabaseConnection {
  return {
    id: 1,
    name: "Atlas — Production",
    kind: "mongodb",
    envKey: "MONGODB_URI",
    preview: "mongodb+srv://appuser:••••@cluster0.ab12c.mongodb.net/",
    inGlobalEnv: false,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides
  };
}

interface FetchLog {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function installFetchMock(options: {
  initial: MaskedDatabaseConnection[];
}) {
  const calls: FetchLog[] = [];
  let list = [...options.initial];

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });

    if (url === "/api/connections" && method === "GET") {
      return jsonResponse(200, { connections: list });
    }
    if (url === "/api/connections" && method === "POST") {
      const created = connection({ id: 2, ...body, envKey: body.envKey || null });
      list = [...list, created];
      return jsonResponse(201, { connection: created });
    }
    if (url.endsWith("/reveal")) {
      return jsonResponse(200, {
        success: true,
        connectionString: "mongodb+srv://appuser:realpw@cluster0.ab12c.mongodb.net/"
      });
    }
    if (url.endsWith("/push-to-global")) {
      list = list.map((c) => ({ ...c, inGlobalEnv: true }));
      return jsonResponse(200, { success: true, key: "MONGODB_URI", created: true });
    }

    throw new Error(`Unhandled fetch: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return { calls };
}

describe("ConnectionsPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("lists connections showing the redacted preview, never a raw secret", async () => {
    installFetchMock({ initial: [connection()] });

    render(<ConnectionsPage />);

    expect(await screen.findByText("Atlas — Production")).toBeInTheDocument();
    expect(
      screen.getByText("mongodb+srv://appuser:••••@cluster0.ab12c.mongodb.net/")
    ).toBeInTheDocument();
    expect(screen.getByText("MONGODB_URI")).toBeInTheDocument();
  });

  test("Copy fetches the revealed string and writes it to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    installFetchMock({ initial: [connection()] });

    render(<ConnectionsPage />);
    await screen.findByText("Atlas — Production");

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      "mongodb+srv://appuser:realpw@cluster0.ab12c.mongodb.net/"
    );
    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });

  test("adding a connection with 'add to every app' checked also pushes it to the global environment", async () => {
    const user = userEvent.setup();
    const { calls } = installFetchMock({ initial: [] });

    render(<ConnectionsPage />);
    await screen.findByText(/No connections yet/);

    await user.click(screen.getByRole("button", { name: "Add Connection" }));

    await user.type(screen.getByPlaceholderText("Atlas — Production"), "My Atlas");
    await user.type(
      screen.getByPlaceholderText(/mongodb\+srv:\/\/user:password/),
      "mongodb+srv://u:p@cluster0.x.mongodb.net/"
    );
    // The default variable-name suggestion + inject checkbox are on by default.
    await user.type(screen.getByPlaceholderText("MONGODB_URI"), "MONGODB_URI");

    await user.click(screen.getByRole("button", { name: "Save Connection" }));

    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/connections" && c.method === "POST")).toBe(true);
      expect(calls.some((c) => c.url.endsWith("/push-to-global") && c.method === "POST")).toBe(true);
    });
  });

  test("a copy-only connection shows no 'Add to apps' action and no variable", async () => {
    installFetchMock({ initial: [connection({ envKey: null })] });

    render(<ConnectionsPage />);
    await screen.findByText("Atlas — Production");

    expect(screen.getByText("Copy-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to apps" })).not.toBeInTheDocument();
  });

  test("'Add to apps' shares an existing connection with every app", async () => {
    const user = userEvent.setup();
    installFetchMock({ initial: [connection({ inGlobalEnv: false })] });

    render(<ConnectionsPage />);
    await screen.findByText("Atlas — Production");

    const row = screen.getByText("Atlas — Production").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Add to apps" }));

    await waitFor(() =>
      expect(screen.getByText("In every app")).toBeInTheDocument()
    );
  });
});
