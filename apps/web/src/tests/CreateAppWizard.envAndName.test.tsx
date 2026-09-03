import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateAppWizard from "../components/CreateAppWizard";

/**
 * Covers two Create-App wizard usability fixes:
 *  - the app-name field lowercases/slugifies as you type
 *  - the Environment step supports bulk-pasting variables
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/environment/global") {
        return jsonResponse(200, { variables: [] });
      }
      if (url === "/api/apps") {
        return jsonResponse(200, {
          apps: [{ id: 12, name: "source-app" }]
        });
      }
      if (url === "/api/integrations/github") {
        return jsonResponse(200, { connected: false });
      }
      if (url === "/api/apps/wizard/brief") {
        return jsonResponse(200, { domain: "x.apps.devminted.com", brief: "brief" });
      }
      if (url === "/api/ports/suggest") {
        return jsonResponse(200, { success: true, port: 4321 });
      }
      throw new Error(`Unhandled fetch in test: ${url}`);
    })
  );
}

describe("CreateAppWizard — name slug + bulk env", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("app name lowercases and slugifies as it is typed", async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(<CreateAppWizard open onClose={() => {}} onCreated={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "Continue" }));
    const nameInput = (await screen.findByLabelText("App name", { exact: false })) as HTMLInputElement;
    await user.type(nameInput, "ClovaChat Website");

    expect(nameInput.value).toBe("clovachat-website");
  });

  test("bulk-pasting variables adds them to the Environment step", async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(<CreateAppWizard open onClose={() => {}} onCreated={() => {}} />);

    // Source -> Basics -> Configure (Environment variables accordion).
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.type(await screen.findByLabelText("App name", { exact: false }), "bulk-test");
    await user.type(screen.getByLabelText("Docker image", { exact: false }), "nginx:alpine");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // In the Configure step's Environment section, open the bulk dialog and paste.
    await user.click(await screen.findByRole("button", { name: "Bulk add" }));
    const dialog = await screen.findByLabelText("Variables");
    await user.type(dialog, "FOO=bar{enter}BAZ=qux");
    await user.click(await screen.findByRole("button", { name: /Apply/ }));

    // Both keys now appear as rows in the step (input values).
    await waitFor(() => {
      expect(screen.getByDisplayValue("FOO")).toBeInTheDocument();
      expect(screen.getByDisplayValue("bar")).toBeInTheDocument();
      expect(screen.getByDisplayValue("BAZ")).toBeInTheDocument();
      expect(screen.getByDisplayValue("qux")).toBeInTheDocument();
    });
    // The dialog closed after applying.
    expect(screen.queryByText("Paste Variables")).not.toBeInTheDocument();
  });

  test("Generate available port fills the port field with the server's suggestion", async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(<CreateAppWizard open onClose={() => {}} onCreated={() => {}} />);

    // Source -> Basics -> Runtime.
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.type(await screen.findByLabelText("App name", { exact: false }), "port-test");
    await user.type(screen.getByLabelText("Docker image", { exact: false }), "nginx:alpine");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const portInput = (await screen.findByLabelText("Container port", { exact: false })) as HTMLInputElement;
    expect(portInput.value).toBe("3000");

    await user.click(screen.getByRole("button", { name: "Generate available port" }));

    await waitFor(() => expect(portInput.value).toBe("4321"));
  });

  test("copies selected app-specific variables from another app", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/environment/global") return jsonResponse(200, { variables: [] });
      if (url === "/api/apps") return jsonResponse(200, { apps: [{ id: 12, name: "source-app" }] });
      if (url === "/api/integrations/github") return jsonResponse(200, { connected: false });
      if (url === "/api/apps/12/environment/copy-source") {
        expect(JSON.parse(String(init?.body))).toEqual({ password: "export-password-123" });
        return jsonResponse(200, {
          success: true,
          variables: [
            { key: "API_TOKEN", value: "secret-value", isSecret: true, enabled: true },
            { key: "PUBLIC_URL", value: "https://example.com", isSecret: false, enabled: true },
            { key: "DISABLED", value: "not-enabled", isSecret: false, enabled: false }
          ]
        });
      }
      if (url === "/api/apps/wizard/brief") {
        return jsonResponse(200, { domain: "x.apps.devminted.com", brief: "brief" });
      }
      throw new Error(`Unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<CreateAppWizard open onClose={() => {}} onCreated={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.type(await screen.findByLabelText("App name", { exact: false }), "copy-test");
    await user.type(screen.getByLabelText("Docker image", { exact: false }), "nginx:alpine");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await user.selectOptions(await screen.findByLabelText("Source app"), "12");
    await user.type(screen.getByLabelText("Environment export password"), "export-password-123");
    await user.click(screen.getByRole("button", { name: "Load Variables" }));

    expect(await screen.findByRole("checkbox", { name: "Copy API_TOKEN" })).not.toBeChecked();
    expect(screen.getByText("PUBLIC_URL")).toBeInTheDocument();
    expect(screen.queryByText("secret-value")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select All" }));
    expect(screen.getByRole("checkbox", { name: "Copy API_TOKEN" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Copy DISABLED" }));
    await user.click(screen.getByRole("button", { name: "Copy Selected (2)" }));

    expect(await screen.findByDisplayValue("API_TOKEN")).toBeInTheDocument();
    expect(screen.getByDisplayValue("secret-value")).toHaveAttribute("type", "password");
    expect(screen.getByDisplayValue("PUBLIC_URL")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("DISABLED")).not.toBeInTheDocument();
    expect(screen.getByText("2 variables copied. Existing keys were updated.")).toBeInTheDocument();
  });
});
