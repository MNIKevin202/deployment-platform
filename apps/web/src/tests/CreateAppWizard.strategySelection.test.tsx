import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateAppWizard from "../components/CreateAppWizard";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const NODEJS_INSPECTION = {
  detectedProjectType: "nodejs",
  recommendedStrategy: "nodejs",
  presentFiles: ["package.json"],
  packageJson: { packageManager: "npm", hasLockfile: true, hasBuildScript: false, hasStartScript: true },
  warnings: [],
  supported: true,
  unsupportedReason: null,
  portDetection: { detectedPort: null, source: "none", confidence: "none", evidence: [], warnings: [] }
};

/** Connected via a GitHub App installation, one repository, and a fixed "nodejs"-recommending inspection result (a root package.json, matching the roadmapstudio-web monorepo scenario). */
function installMock() {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === "/api/environment/global") {
      return jsonResponse(200, { variables: [] });
    }
    if (url === "/api/integrations/github") {
      return jsonResponse(200, { connected: false });
    }
    if (url === "/api/github/installations") {
      return jsonResponse(200, { success: true, configured: true, installations: [{ installationId: 555 }] });
    }
    if (url.endsWith("/inspect")) {
      return jsonResponse(200, { success: true, commitSha: "abc123", inspection: NODEJS_INSPECTION });
    }
    if (url.startsWith("/api/integrations/github/repositories/")) {
      return jsonResponse(200, { success: true, branches: [{ name: "main" }] });
    }
    if (url.startsWith("/api/integrations/github/repositories")) {
      return jsonResponse(200, {
        success: true,
        repositories: [
          {
            id: "1",
            owner: "MNIKevin202",
            name: "DeploymentPlatformInstaller",
            fullName: "MNIKevin202/DeploymentPlatformInstaller",
            private: true,
            archived: false,
            description: null,
            defaultBranch: "main",
            htmlUrl: "https://github.com/MNIKevin202/DeploymentPlatformInstaller",
            pushedAt: null,
            updatedAt: null
          }
        ],
        hasMore: false,
        source: "installation"
      });
    }
    if (url === "/api/apps/wizard/brief") {
      return jsonResponse(200, { domain: "routing-test.apps.devminted.com", brief: "fake brief text" });
    }

    throw new Error(`Unhandled fetch in test: ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return impl;
}

async function goToInspectedGithubSource(user: ReturnType<typeof userEvent.setup>) {
  render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
  await user.click(await screen.findByText("Deploy from GitHub"));
  await user.click(await screen.findByText("MNIKevin202/DeploymentPlatformInstaller"));
  await user.click(await screen.findByText("MNIKevin202/DeploymentPlatformInstaller"));
  // Inspection now runs automatically once a repo + branch are selected.
  await screen.findByRole("button", { name: "Re-inspect Repository" });
  await screen.findByText("Detected type");
}

const dockerfileCardName = /Dockerfile.*Build using the Dockerfile/s;
const nodejsCardName = /Node\.js.*Use the platform-managed/s;

describe("CreateAppWizard — manual deployment-strategy override", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  test("a Node.js-detected repository can manually select Dockerfile", async () => {
    const user = userEvent.setup();
    installMock();

    await goToInspectedGithubSource(user);

    const dockerfileCard = screen.getByRole("button", { name: dockerfileCardName });
    expect(dockerfileCard).not.toBeDisabled();
    await user.click(dockerfileCard);

    expect(dockerfileCard).toHaveAttribute("aria-pressed", "true");
    await screen.findByText("Dockerfile path");
  });

  test("a nested Dockerfile path can be entered", async () => {
    const user = userEvent.setup();
    installMock();

    await goToInspectedGithubSource(user);
    await user.click(screen.getByRole("button", { name: dockerfileCardName }));

    const dockerfilePathInput = await screen.findByPlaceholderText("Dockerfile");
    await user.clear(dockerfilePathInput);
    await user.type(dockerfilePathInput, "tools/roadmap-studio/Dockerfile");

    expect(dockerfilePathInput).toHaveValue("tools/roadmap-studio/Dockerfile");
  });

  test("without a manual choice, the recommendation is still applied automatically (default behavior unchanged)", async () => {
    const user = userEvent.setup();
    installMock();

    await goToInspectedGithubSource(user);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: nodejsCardName })).toHaveAttribute("aria-pressed", "true");
    });
  });

  test("save and deploy sends the manually-selected strategy, not the inspection recommendation", async () => {
    const user = userEvent.setup();
    const impl = installMock();

    await goToInspectedGithubSource(user);
    await user.click(screen.getByRole("button", { name: dockerfileCardName }));
    const dockerfilePathInput = await screen.findByPlaceholderText("Dockerfile");
    await user.clear(dockerfilePathInput);
    await user.type(dockerfilePathInput, "tools/roadmap-studio/Dockerfile");

    // Fill in the minimum required fields to reach a valid submission.
    await user.click(screen.getByRole("button", { name: "Continue" })); // Basics
    const nameInput = screen.getByPlaceholderText("hello-nginx");
    await user.clear(nameInput);
    await user.type(nameInput, "roadmapstudio-web");
    await user.click(screen.getByRole("button", { name: "Continue" })); // Runtime
    await user.click(screen.getByRole("button", { name: "Continue" })); // Environment
    await user.click(screen.getByRole("button", { name: "Continue" })); // Storage
    await user.click(screen.getByRole("button", { name: "Continue" })); // Domain
    await user.click(screen.getByRole("button", { name: "Continue" })); // Review
    await screen.findByText("Claude Build Brief");

    // Wire up the create + source-link responses now that other endpoints are settled.
    const baseImpl = impl.getMockImplementation()!;
    impl.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/apps/wizard" && init?.method === "POST") {
        return jsonResponse(200, {
          success: true,
          app: {
            id: 42,
            name: "roadmapstudio-web",
            status: "running",
            domain: null,
            internalOnly: false,
            routingReady: false,
            environmentVariableCount: 0,
            secretVariableCount: 0,
            storageMountCount: 0
          }
        });
      }
      if (url === "/api/apps/42/source" && init?.method === "PUT") {
        const payload = JSON.parse(init.body as string) as Record<string, unknown>;
        (globalThis as { __capturedSourcePayload?: unknown }).__capturedSourcePayload = payload;
        return jsonResponse(200, { success: true, source: payload });
      }
      if (url === "/api/apps/42/deploy/github" && init?.method === "POST") {
        return jsonResponse(200, { success: true, message: "ok" });
      }
      return baseImpl(input);
    });

    await user.click(screen.getByRole("button", { name: "Create and Deploy" }));

    await waitFor(() => {
      const captured = (globalThis as { __capturedSourcePayload?: Record<string, unknown> }).__capturedSourcePayload;
      expect(captured?.selectedStrategy).toBe("dockerfile");
      expect(captured?.deploymentMode).toBe("dockerfile");
      expect(captured?.dockerfilePath).toBe("tools/roadmap-studio/Dockerfile");
    });

    delete (globalThis as { __capturedSourcePayload?: unknown }).__capturedSourcePayload;
  });
});
