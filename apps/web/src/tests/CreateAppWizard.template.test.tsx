import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CreateAppWizard from "../components/CreateAppWizard";
import { APP_TEMPLATES } from "../lib/appTemplates";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/environment/global") return jsonResponse(200, { variables: [] });
      if (url === "/api/integrations/github") return jsonResponse(200, { connected: false });
      if (url === "/api/apps/wizard/brief") return jsonResponse(200, { domain: "x", brief: "b" });
      throw new Error(`Unhandled fetch in test: ${url}`);
    })
  );
}

describe("CreateAppWizard — template pre-fill", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("seeds the Basics step with the template's name and image", async () => {
    installFetchMock();
    const postgres = APP_TEMPLATES.find((t) => t.id === "postgres")!;

    render(<CreateAppWizard open initialTemplate={postgres} onClose={() => {}} onCreated={() => {}} />);

    // The wizard jumps to Basics with the template values pre-filled.
    const nameInput = (await screen.findByLabelText("App name", { exact: false })) as HTMLInputElement;
    expect(nameInput.value).toBe("postgres");

    const imageInput = screen.getByLabelText("Docker image", { exact: false }) as HTMLInputElement;
    expect(imageInput.value).toBe("postgres:16-alpine");
  });
});
