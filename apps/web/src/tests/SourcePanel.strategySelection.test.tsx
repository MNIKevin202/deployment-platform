import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SourcePanel from "../components/SourcePanel";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

interface SourceFixtureOverrides {
  selectedStrategy?: "dockerfile" | "nodejs" | "static" | null;
  dockerfilePath?: string;
  buildContext?: string;
  subdirectory?: string;
  deploymentMode?: "dockerfile" | "prebuilt-image";
}

function sourceFixture(overrides: SourceFixtureOverrides = {}) {
  return {
    appId: 1,
    provider: "github",
    repositoryOwner: "MNIKevin202",
    repositoryName: "DeploymentPlatformInstaller",
    repositoryFullName: "MNIKevin202/DeploymentPlatformInstaller",
    repositoryId: null,
    repositoryVisibility: "private",
    branch: "main",
    subdirectory: overrides.subdirectory ?? ".",
    deploymentMode: overrides.deploymentMode ?? "prebuilt-image",
    dockerfilePath: overrides.dockerfilePath ?? "Dockerfile",
    buildContext: overrides.buildContext ?? ".",
    buildStrategy: "nodejs",
    selectedStrategy: overrides.selectedStrategy ?? null,
    detectedProjectType: "nodejs",
    containerPort: 4319,
    containerPortSource: null,
    containerPortConfidence: null,
    autoDeploy: false,
    validationStatus: "valid",
    validationError: null,
    lastValidatedCommitSha: "abc1234",
    lastValidatedAt: "2026-01-01T00:00:00.000Z",
    latestRemoteCommitSha: null,
    latestDeployedCommitSha: null,
    latestDeployedCommitMessage: null,
    latestDeployedAt: null,
    lastInternalHealthResult: null,
    lastPublicHealthResult: null,
    lastDeploymentStatus: null,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
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

interface MockState {
  source: ReturnType<typeof sourceFixture> | null;
  inspection?: typeof NODEJS_INSPECTION;
}

function installMock(state: MockState) {
  const putCalls: unknown[] = [];
  let currentSource = state.source;

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === "/api/apps/1/source" && (!init || init.method === undefined)) {
      return jsonResponse(200, { success: true, source: currentSource });
    }
    if (url === "/api/apps/1/source" && init?.method === "PUT") {
      const payload = JSON.parse(init.body as string) as Record<string, unknown>;
      putCalls.push(payload);
      currentSource = {
        ...sourceFixture(),
        ...payload,
        appId: 1,
        buildStrategy: currentSource?.buildStrategy ?? "nodejs"
      } as ReturnType<typeof sourceFixture>;
      return jsonResponse(200, { success: true, source: currentSource });
    }
    if (url === "/api/integrations/github") {
      return jsonResponse(200, {
        success: true,
        connected: true,
        provider: "github",
        username: "octocat",
        lastValidatedAt: null,
        credentialStatus: "valid",
        permissions: null,
        setupRequired: false
      });
    }
    if (url === "/api/github/installations") {
      return jsonResponse(200, { success: true, configured: true, installations: [] });
    }
    if (url === "/api/apps/1/deploy/github/status") {
      return jsonResponse(200, { inProgress: false });
    }
    if (url.startsWith("/api/integrations/github/repositories/MNIKevin202/DeploymentPlatformInstaller/branches")) {
      return jsonResponse(200, { success: true, branches: [{ name: "main", commitSha: "abc1234", protected: false }] });
    }
    if (url.endsWith("/inspect") && init?.method === "POST" && url.includes("/repositories/")) {
      return jsonResponse(200, { success: true, commitSha: "abc1234", inspection: state.inspection ?? NODEJS_INSPECTION });
    }
    if (url.startsWith("/api/integrations/github/repositories/MNIKevin202/DeploymentPlatformInstaller/commits")) {
      return jsonResponse(200, { success: true, commits: [], hasMore: false });
    }
    if (url === "/api/apps/1/source/inspect" && init?.method === "POST") {
      return jsonResponse(200, { success: true, commitSha: "abc1234", inspection: state.inspection ?? NODEJS_INSPECTION });
    }

    throw new Error(`Unhandled fetch in test: ${url} ${init?.method ?? "GET"}`);
  });

  vi.stubGlobal("fetch", impl);
  return { putCalls, impl };
}

/** The Edit Source dialog is a modal rendered ALONGSIDE the main Source panel — the main panel has its own "Inspect Repository" button too, so every dialog interaction must be scoped with within() to avoid ambiguous matches. */
function dialog(): HTMLElement {
  const modal = document.querySelector(".form-modal.wizard-modal");
  if (!modal) {
    throw new Error("Edit Source dialog is not open");
  }
  return modal as HTMLElement;
}

async function openEditSource(user: ReturnType<typeof userEvent.setup>) {
  render(<SourcePanel appId={1} />);
  await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");
  await user.click(screen.getByRole("button", { name: "Edit Source" }));
  await within(dialog()).findByText("Edit Source");
}

async function goToDeploymentStep(user: ReturnType<typeof userEvent.setup>) {
  // Resumes at "Branch" step for Edit Source. Continue -> Inspect step.
  await user.click(within(dialog()).getByRole("button", { name: "Continue" }));
  await user.click(await within(dialog()).findByRole("button", { name: "Inspect Repository" }));
  await within(dialog()).findByText("Detected type");
  // Continue -> Deployment step.
  await user.click(within(dialog()).getByRole("button", { name: "Continue" }));
}

const dockerfileCardName = /Dockerfile.*Build using the Dockerfile/s;
const nodejsCardName = /Node\.js.*Use the platform-managed/s;

describe("SourcePanel — manual deployment-strategy override", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a Node.js-detected repository can manually select Dockerfile", async () => {
    const user = userEvent.setup();
    installMock({ source: sourceFixture() });

    await openEditSource(user);
    await goToDeploymentStep(user);

    // Recommended strategy is nodejs — Dockerfile is still selectable.
    const dockerfileCard = within(dialog()).getByRole("button", { name: dockerfileCardName });
    expect(dockerfileCard).not.toBeDisabled();
    await user.click(dockerfileCard);

    expect(dockerfileCard).toHaveAttribute("aria-pressed", "true");
    await within(dialog()).findByText("Dockerfile path");
  });

  test("a nested Dockerfile path can be entered", async () => {
    const user = userEvent.setup();
    installMock({ source: sourceFixture() });

    await openEditSource(user);
    await goToDeploymentStep(user);

    await user.click(within(dialog()).getByRole("button", { name: dockerfileCardName }));
    const dockerfilePathInput = await within(dialog()).findByPlaceholderText("Dockerfile");
    await user.clear(dockerfilePathInput);
    await user.type(dockerfilePathInput, "tools/roadmap-studio/Dockerfile");

    expect(dockerfilePathInput).toHaveValue("tools/roadmap-studio/Dockerfile");
  });

  test('build context "." remains the repository root when subdirectory is "."', async () => {
    const user = userEvent.setup();
    installMock({ source: sourceFixture({ subdirectory: "." }) });

    await openEditSource(user);
    await goToDeploymentStep(user);

    await user.click(within(dialog()).getByRole("button", { name: dockerfileCardName }));
    const buildContextInput = await within(dialog()).findByPlaceholderText(".");
    expect(buildContextInput).toHaveValue(".");
  });

  test("manual Dockerfile strategy survives step navigation (back and forward)", async () => {
    const user = userEvent.setup();
    installMock({ source: sourceFixture() });

    await openEditSource(user);
    await goToDeploymentStep(user);

    await user.click(within(dialog()).getByRole("button", { name: dockerfileCardName }));
    await within(dialog()).findByText("Dockerfile path");

    // Back to Inspect, then forward again to Deployment.
    await user.click(within(dialog()).getByRole("button", { name: "Back" }));
    await within(dialog()).findByText("Detected type");
    await user.click(within(dialog()).getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(within(dialog()).getByRole("button", { name: dockerfileCardName })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
    await within(dialog()).findByText("Dockerfile path");
  });

  test("save and deploy uses the manually-selected strategy, not the inspection recommendation", async () => {
    const user = userEvent.setup();
    const { putCalls } = installMock({ source: sourceFixture() });

    await openEditSource(user);
    await goToDeploymentStep(user);

    await user.click(within(dialog()).getByRole("button", { name: dockerfileCardName }));
    const dockerfilePathInput = await within(dialog()).findByPlaceholderText("Dockerfile");
    await user.clear(dockerfilePathInput);
    await user.type(dockerfilePathInput, "tools/roadmap-studio/Dockerfile");

    await user.click(within(dialog()).getByRole("button", { name: "Continue" }));
    await within(dialog()).findByText("Save changes and deploy");
    await user.click(within(dialog()).getByRole("button", { name: "Save changes and deploy" }));

    await waitFor(() => expect(putCalls.length).toBeGreaterThan(0));
    const payload = putCalls[0] as Record<string, unknown>;
    expect(payload.selectedStrategy).toBe("dockerfile");
    expect(payload.deploymentMode).toBe("dockerfile");
    expect(payload.dockerfilePath).toBe("tools/roadmap-studio/Dockerfile");
    expect(payload.buildContext).toBe(".");
  });

  test("Edit Source preserves an existing manually-selected strategy on reopen", async () => {
    const user = userEvent.setup();
    installMock({
      source: sourceFixture({
        selectedStrategy: "dockerfile",
        dockerfilePath: "tools/roadmap-studio/Dockerfile",
        deploymentMode: "dockerfile"
      })
    });

    await openEditSource(user);
    // No inspection has run yet in this session — but the persisted
    // selectedStrategy must already be reflected once we reach the
    // Deployment step, after the mandatory re-inspection.
    await goToDeploymentStep(user);

    await waitFor(() => {
      expect(within(dialog()).getByRole("button", { name: dockerfileCardName })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
    expect(within(dialog()).getByPlaceholderText("Dockerfile")).toHaveValue("tools/roadmap-studio/Dockerfile");
  });

  test("an inspection rerun does not overwrite a manual strategy choice", async () => {
    const user = userEvent.setup();
    installMock({ source: sourceFixture() });

    await openEditSource(user);
    await goToDeploymentStep(user);

    // Manually choose Dockerfile (recommendation is nodejs).
    await user.click(within(dialog()).getByRole("button", { name: dockerfileCardName }));
    await within(dialog()).findByText("Dockerfile path");

    // Go back and re-inspect (same repo/branch/subdirectory — inspection
    // still recommends nodejs).
    await user.click(within(dialog()).getByRole("button", { name: "Back" }));
    await user.click(within(dialog()).getByRole("button", { name: "Re-inspect Repository" }));
    await within(dialog()).findByText("Detected type");
    await user.click(within(dialog()).getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(within(dialog()).getByRole("button", { name: dockerfileCardName })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
  });

  test("without a manual choice, the recommendation is still applied automatically (default behavior unchanged)", async () => {
    const user = userEvent.setup();
    installMock({ source: sourceFixture() });

    await openEditSource(user);
    await goToDeploymentStep(user);

    await waitFor(() => {
      const nodejsCard = within(dialog()).getByRole("button", { name: nodejsCardName });
      expect(nodejsCard).toHaveAttribute("aria-pressed", "true");
    });
  });
});
