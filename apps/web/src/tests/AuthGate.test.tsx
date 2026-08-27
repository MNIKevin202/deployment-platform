import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import AuthGate from "../AuthGate";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("AuthGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("opens the sign-in form with an empty username", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();

        if (url === "/api/auth/session") {
          return jsonResponse(200, { authenticated: false });
        }

        throw new Error(`Unhandled fetch in test: ${url}`);
      })
    );

    render(
      <AuthGate>
        <div>Signed in content</div>
      </AuthGate>
    );

    const username = await screen.findByLabelText("Username");
    expect(username).toHaveValue("");
  });
});
