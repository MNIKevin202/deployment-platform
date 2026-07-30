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
      if (url === "/api/integrations/github") {
        return jsonResponse(200, { connected: false });
      }
      if (url === "/api/apps/wizard/brief") {
        return jsonResponse(200, { domain: "x.apps.devminted.com", brief: "brief" });
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

    // Source -> Basics -> Runtime -> Environment.
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.type(await screen.findByLabelText("App name", { exact: false }), "bulk-test");
    await user.type(screen.getByLabelText("Docker image", { exact: false }), "nginx:alpine");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));

    // On the Environment step, open the bulk dialog and paste.
    await user.click(await screen.findByRole("button", { name: "Bulk add" }));
    const dialog = await screen.findByRole("textbox");
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
});
