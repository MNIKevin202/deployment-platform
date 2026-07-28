import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SourcePanel from "../components/SourcePanel";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const SOURCE_FIXTURE = {
  appId: 1,
  provider: "github",
  repositoryOwner: "MNIKevin202",
  repositoryName: "DeploymentPlatformInstaller",
  repositoryFullName: "MNIKevin202/DeploymentPlatformInstaller",
  repositoryId: null,
  repositoryVisibility: "private",
  branch: "main",
  subdirectory: "tools/roadmap-studio",
  deploymentMode: "dockerfile",
  dockerfilePath: "Dockerfile",
  buildContext: ".",
  containerPort: 4319,
  containerPortSource: null,
  containerPortConfidence: null,
  autoDeploy: false,
  validationStatus: "valid",
  validationError: null,
  lastValidatedCommitSha: "abc1234",
  lastValidatedAt: "2026-01-01T00:00:00.000Z",
  buildStrategy: "dockerfile",
  detectedProjectType: "dockerfile",
  latestRemoteCommitSha: null,
  latestDeployedCommitSha: null,
  latestDeployedCommitMessage: null,
  latestDeployedAt: null,
  lastInternalHealthResult: null,
  lastPublicHealthResult: null,
  lastDeploymentStatus: null,
  createdAt: "2026-01-01T00:00:00.000Z"
};

interface MockOptions {
  patConnected: boolean;
  installationCount: number;
}

function installFetchMock({ patConnected, installationCount }: MockOptions) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === "/api/apps/1/source") {
      return jsonResponse(200, { success: true, source: SOURCE_FIXTURE });
    }
    if (url === "/api/integrations/github") {
      return jsonResponse(200, {
        success: true,
        connected: patConnected,
        provider: "github",
        username: patConnected ? "octocat" : null,
        lastValidatedAt: null,
        credentialStatus: patConnected ? "valid" : "not-configured",
        permissions: null,
        setupRequired: false
      });
    }
    if (url === "/api/github/installations") {
      const installations = Array.from({ length: installationCount }, (_, i) => ({ installationId: i + 1 }));
      return jsonResponse(200, { success: true, configured: true, installations });
    }
    if (url === "/api/apps/1/deploy/github/status") {
      return jsonResponse(200, { inProgress: false });
    }

    throw new Error(`Unhandled fetch in test: ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return impl;
}

describe("SourcePanel — GitHub App installation satisfies the connection check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a GitHub App installation alone (no PAT) is reported as connected, not 'GitHub is not connected'", async () => {
    installFetchMock({ patConnected: false, installationCount: 1 });

    render(<SourcePanel appId={1} />);

    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");
    expect(screen.queryByText("GitHub is not connected. Connect it from the Repositories section before linking or validating a source.")).not.toBeInTheDocument();
    expect(screen.queryByText("GitHub connection required")).not.toBeInTheDocument();
  });

  test("a GitHub App installation does not disable Inspect Repository or Deploy from GitHub", async () => {
    installFetchMock({ patConnected: false, installationCount: 1 });

    render(<SourcePanel appId={1} />);
    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Repository" })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "Deploy from GitHub" })).not.toBeDisabled();
    });
  });

  test("PAT-only connection (no GitHub App installation) still counts as connected — fallback remains supported", async () => {
    installFetchMock({ patConnected: true, installationCount: 0 });

    render(<SourcePanel appId={1} />);
    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");

    expect(screen.queryByText("GitHub connection required")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Repository" })).not.toBeDisabled();
    });
  });

  test("neither a PAT nor a GitHub App installation: the warning banner shows and actions are disabled", async () => {
    installFetchMock({ patConnected: false, installationCount: 0 });

    render(<SourcePanel appId={1} />);
    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");

    await screen.findByText(
      "GitHub is not connected. Connect it from the Repositories section before linking or validating a source."
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Inspect Repository" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Deploy from GitHub" })).toBeDisabled();
    });
  });

  test("Validate Again is never disabled by connection state (it works regardless, matching the backend's own resolver)", async () => {
    installFetchMock({ patConnected: false, installationCount: 0 });

    render(<SourcePanel appId={1} />);
    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");

    expect(screen.getByRole("button", { name: "Validate Again" })).not.toBeDisabled();
  });
});
