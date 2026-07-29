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

/**
 * A "dockerfile" strategy repository whose Dockerfile EXPOSEs 3117 — the
 * ButtonPicker scenario that motivated this feature: the platform's
 * placeholder container port previously had nothing to do with what the
 * repository's own Dockerfile actually listens on, so a deploy would build
 * successfully and then fail health checks against the wrong port.
 */
const HIGH_CONFIDENCE_INSPECTION = {
  detectedProjectType: "dockerfile",
  recommendedStrategy: "dockerfile",
  presentFiles: ["Dockerfile", "package.json"],
  packageJson: null,
  warnings: [],
  supported: true,
  unsupportedReason: null,
  portDetection: {
    detectedPort: 3117,
    source: "dockerfile-expose",
    confidence: "high",
    evidence: ["Dockerfile EXPOSE 3117"],
    warnings: []
  }
};

const NO_DETECTION_INSPECTION = {
  detectedProjectType: "dockerfile",
  recommendedStrategy: "dockerfile",
  presentFiles: ["Dockerfile"],
  packageJson: null,
  warnings: [],
  supported: true,
  unsupportedReason: null,
  portDetection: {
    detectedPort: null,
    source: "none",
    confidence: "none",
    evidence: [],
    warnings: ["No listening port could be detected. Enter the container port manually."]
  }
};

function installMock(inspection: unknown) {
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
      return jsonResponse(200, { success: true, commitSha: "abc123", inspection });
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
            name: "buttonpicker",
            fullName: "MNIKevin202/buttonpicker",
            private: false,
            archived: false,
            description: null,
            defaultBranch: "main",
            htmlUrl: "https://github.com/MNIKevin202/buttonpicker",
            pushedAt: null,
            updatedAt: null
          }
        ],
        hasMore: false,
        source: "installation"
      });
    }
    if (url === "/api/apps/wizard/brief") {
      return jsonResponse(200, { domain: "buttonpicker.apps.devminted.com", brief: "fake brief text" });
    }

    throw new Error(`Unhandled fetch in test: ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return impl;
}

async function goToInspectedGithubSource(user: ReturnType<typeof userEvent.setup>) {
  render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
  await user.click(await screen.findByText("Deploy from GitHub"));
  await user.click(await screen.findByText("MNIKevin202/buttonpicker"));
  await user.click(await screen.findByText("MNIKevin202/buttonpicker"));
  await user.click(screen.getByRole("button", { name: "Inspect Repository" }));
  await screen.findByText("Detected type");
}

async function goToDeploymentStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Continue" })); // Basics
  const nameInput = screen.getByPlaceholderText("hello-nginx");
  await user.clear(nameInput);
  await user.type(nameInput, "buttonpicker");
  await user.click(screen.getByRole("button", { name: "Continue" })); // Runtime (Container port lives here)
}

describe("CreateAppWizard — GitHub repository port detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  test("a high-confidence Dockerfile EXPOSE prefills the container port field", async () => {
    const user = userEvent.setup();
    installMock(HIGH_CONFIDENCE_INSPECTION);

    await goToInspectedGithubSource(user);

    // Surfaced at the inspect step too, so the operator can see where it came from.
    await screen.findByText("Suggested container port");
    expect(screen.getByText("3117")).toBeInTheDocument();
    expect(screen.getByText("Dockerfile EXPOSE")).toBeInTheDocument();

    await goToDeploymentStep(user);

    const portInput = screen.getByPlaceholderText("3000") as HTMLInputElement;
    expect(portInput.value).toBe("3117");
    expect(screen.getByText(/Detected from Dockerfile EXPOSE \(high confidence\)\./)).toBeInTheDocument();
  });

  test("no detected port leaves the field at its unconfirmed default and shows the warning instead of guessing", async () => {
    const user = userEvent.setup();
    installMock(NO_DETECTION_INSPECTION);

    await goToInspectedGithubSource(user);
    await goToDeploymentStep(user);

    // Nothing was detected, so the field is left untouched (still the
    // generic default) rather than the wizard guessing a value — and the
    // hint reflects that it wasn't actually detected from anything.
    const portInput = screen.getByPlaceholderText("3000") as HTMLInputElement;
    expect(portInput.value).toBe("3000");
    expect(screen.getByText("Manually entered.")).toBeInTheDocument();
    expect(
      screen.getByText("No listening port could be detected. Enter the container port manually.")
    ).toBeInTheDocument();
  });

  test("a manual edit after detection survives a re-inspect (never silently clobbered)", async () => {
    const user = userEvent.setup();
    installMock(HIGH_CONFIDENCE_INSPECTION);

    await goToInspectedGithubSource(user);
    await goToDeploymentStep(user);

    const portInput = screen.getByPlaceholderText("3000") as HTMLInputElement;
    expect(portInput.value).toBe("3117");

    await user.clear(portInput);
    await user.type(portInput, "8080");
    expect(screen.getByText("Manually entered.")).toBeInTheDocument();

    // Go back and re-inspect — the manual value must not be overwritten.
    await user.click(screen.getByRole("button", { name: "Back" })); // Runtime -> Basics
    await user.click(screen.getByRole("button", { name: "Back" })); // Basics -> Source
    await user.click(screen.getByRole("button", { name: "Re-inspect Repository" }));
    await screen.findByText("Detected type");
    await goToDeploymentStep(user);

    expect((screen.getByPlaceholderText("3000") as HTMLInputElement).value).toBe("8080");
    expect(screen.getByText("Manually entered.")).toBeInTheDocument();
  });

  test("save and deploy sends the detected port with its source and confidence", async () => {
    const user = userEvent.setup();
    const impl = installMock(HIGH_CONFIDENCE_INSPECTION);

    await goToInspectedGithubSource(user);
    await goToDeploymentStep(user);
    await user.click(screen.getByRole("button", { name: "Continue" })); // Environment
    await user.click(screen.getByRole("button", { name: "Continue" })); // Storage
    await user.click(screen.getByRole("button", { name: "Continue" })); // Domain
    await user.click(screen.getByRole("button", { name: "Continue" })); // Review
    await screen.findByText("Claude Build Brief");

    const baseImpl = impl.getMockImplementation()!;
    impl.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/apps/wizard" && init?.method === "POST") {
        return jsonResponse(200, {
          success: true,
          app: {
            id: 99,
            name: "buttonpicker",
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
      if (url === "/api/apps/99/source" && init?.method === "PUT") {
        const payload = JSON.parse(init.body as string) as Record<string, unknown>;
        (globalThis as { __capturedSourcePayload?: unknown }).__capturedSourcePayload = payload;
        return jsonResponse(200, { success: true, source: payload });
      }
      if (url === "/api/apps/99/deploy/github" && init?.method === "POST") {
        return jsonResponse(200, { success: true, message: "ok" });
      }
      return baseImpl(input);
    });

    await user.click(screen.getByRole("button", { name: "Create and Deploy" }));

    await waitFor(() => {
      const captured = (globalThis as { __capturedSourcePayload?: Record<string, unknown> }).__capturedSourcePayload;
      expect(captured?.containerPort).toBe(3117);
      expect(captured?.containerPortSource).toBe("dockerfile-expose");
      expect(captured?.containerPortConfidence).toBe("high");
    });

    delete (globalThis as { __capturedSourcePayload?: unknown }).__capturedSourcePayload;
  });
});
