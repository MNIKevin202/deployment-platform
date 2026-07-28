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

function installFetchMock(options: { githubAppConfigured: boolean }) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === "/api/environment/global") {
      return jsonResponse(200, { variables: [] });
    }
    if (url === "/api/integrations/github") {
      return jsonResponse(200, { connected: false });
    }
    if (url === "/api/github/installations") {
      return jsonResponse(200, { success: true, configured: options.githubAppConfigured, installations: [] });
    }
    if (url === "/api/apps/wizard/brief") {
      return jsonResponse(200, { domain: "routing-test.apps.devminted.com", brief: "fake brief text" });
    }

    throw new Error(`Unhandled fetch in test: ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return impl;
}

async function goToSourceStepAndSelectGithub(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText("Deploy from GitHub"));
}

describe("CreateAppWizard — GitHub App awareness on the Source step", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  test("GitHub App configured, no installation: shows a Connect GitHub action and sets the resume flag on click", async () => {
    const user = userEvent.setup();
    installFetchMock({ githubAppConfigured: true });

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);

    const connectLink = await screen.findByRole("link", { name: "Connect GitHub" });
    expect(connectLink).toHaveAttribute("href", "/api/github/connect");

    expect(window.sessionStorage.getItem("dp_resume_create_app_wizard")).toBeNull();
    await user.click(connectLink);
    expect(window.sessionStorage.getItem("dp_resume_create_app_wizard")).toBe("1");
  });

  test("GitHub App not configured: explains the fallback instead of offering a dead Connect action", async () => {
    const user = userEvent.setup();
    installFetchMock({ githubAppConfigured: false });

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);

    expect(screen.queryByRole("link", { name: "Connect GitHub" })).not.toBeInTheDocument();
    await screen.findByText(/GitHub App is not configured on this server yet/);
  });
});
