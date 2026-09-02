import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateAppWizard from "../components/CreateAppWizard";

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
      if (url === "/api/environment/global") return jsonResponse(200, { variables: [] });
      if (url === "/api/apps") return jsonResponse(200, { apps: [] });
      if (url === "/api/integrations/github") return jsonResponse(200, { connected: false });
      throw new Error(`Unhandled fetch in test: ${url}`);
    })
  );
}

describe("CreateAppWizard — common app dropdown", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function openBasics() {
    const user = userEvent.setup();
    render(<CreateAppWizard open onClose={() => {}} onCreated={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    return user;
  }

  test("picking a common app fills in its Docker image", async () => {
    installFetchMock();
    const user = await openBasics();

    const picker = (await screen.findByLabelText("Common app", {
      exact: false
    })) as HTMLSelectElement;
    const image = screen.getByLabelText("Docker image", { exact: false }) as HTMLInputElement;

    expect(image.value).toBe("");

    await user.selectOptions(picker, "nginx");

    expect(image.value).toBe("nginx:alpine");
  });

  test("the picker offers common apps by name, not image strings", async () => {
    installFetchMock();
    await openBasics();

    // Friendly names an operator would recognize, rather than "nginx:alpine".
    expect(await screen.findByRole("option", { name: "Nginx" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "PostgreSQL" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Redis" })).toBeInTheDocument();
  });

  test("typing a custom image resets the picker to Custom", async () => {
    installFetchMock();
    const user = await openBasics();

    const picker = (await screen.findByLabelText("Common app", {
      exact: false
    })) as HTMLSelectElement;
    await user.selectOptions(picker, "nginx");
    expect(picker.value).toBe("nginx");

    const image = screen.getByLabelText("Docker image", { exact: false }) as HTMLInputElement;
    await user.clear(image);
    await user.type(image, "my-registry/custom:1.2.3");

    expect(picker.value).toBe("");
  });
});
