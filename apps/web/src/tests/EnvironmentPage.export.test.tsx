import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EnvironmentPage from "../pages/EnvironmentPage";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("EnvironmentPage protected export", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("requires the export password and copies the server-provided content", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/environment/global" && !init?.method) {
        return jsonResponse(200, { variables: [] });
      }
      if (url === "/api/environment/global/export" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ password: "export-password-123" });
        return jsonResponse(200, { content: "API_KEY=hidden-value" });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<EnvironmentPage />);
    await screen.findByText(/No global variables yet/);
    await user.click(screen.getByRole("button", { name: "Copy All" }));
    await user.type(screen.getByLabelText("Environment export password"), "export-password-123");
    await user.click(screen.getByRole("button", { name: "Copy all" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("API_KEY=hidden-value"));
    expect(await screen.findByText(/including secret values/)).toBeInTheDocument();
  });
});
