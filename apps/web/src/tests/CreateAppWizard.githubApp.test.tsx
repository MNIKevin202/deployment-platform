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

interface RepoFixture {
  id: string;
  owner: string;
  name: string;
}

function repoBody(repo: RepoFixture) {
  return {
    id: repo.id,
    owner: repo.owner,
    name: repo.name,
    fullName: `${repo.owner}/${repo.name}`,
    private: repo.owner === "MNIKevin202",
    archived: false,
    description: null,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${repo.owner}/${repo.name}`,
    pushedAt: null,
    updatedAt: null
  };
}

/**
 * Installs a connected-via-GitHub-App fetch mock that serves the given
 * repository pages in request order (ignoring the requested page number)
 * — enough to exercise the wizard's full auto-pagination.
 */
function installConnectedRepoFetchMock(pages: RepoFixture[][]) {
  let pageIndex = 0;

  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === "/api/environment/global") {
      return jsonResponse(200, { variables: [] });
    }
    if (url === "/api/integrations/github") {
      return jsonResponse(200, { connected: false });
    }
    if (url === "/api/github/installations") {
      return jsonResponse(200, {
        success: true,
        configured: true,
        installations: [{ installationId: 555 }]
      });
    }
    if (url.endsWith("/inspect")) {
      return jsonResponse(200, {
        success: true,
        commitSha: "abc123",
        inspection: {
          detectedProjectType: "docker",
          recommendedStrategy: "dockerfile",
          supported: true,
          warnings: [],
          portDetection: {
            detectedPort: null,
            source: "none",
            confidence: "none",
            evidence: [],
            warnings: []
          }
        }
      });
    }
    if (url.startsWith("/api/integrations/github/repositories/")) {
      // Branch lookup after selecting a repository — not under test here.
      return jsonResponse(200, { success: true, branches: [{ name: "main" }] });
    }
    if (url.startsWith("/api/integrations/github/repositories")) {
      const items = pages[pageIndex] ?? [];
      const hasMore = pageIndex < pages.length - 1;
      pageIndex += 1;
      return jsonResponse(200, { success: true, repositories: items.map(repoBody), hasMore, source: "installation" });
    }
    if (url === "/api/apps/wizard/brief") {
      return jsonResponse(200, { domain: "routing-test.apps.devminted.com", brief: "fake brief text" });
    }

    throw new Error(`Unhandled fetch in test: ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return impl;
}

describe("CreateAppWizard — repository loading, pagination, and search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  test("displays and allows selecting a repository from a later page", async () => {
    const user = userEvent.setup();
    const page1 = Array.from({ length: 20 }, (_, i) => ({ id: String(i), owner: "MNIKevin202", name: `repo-${i}` }));
    const page2 = [{ id: "target", owner: "MNIKevin202", name: "DeploymentPlatformInstaller" }];
    installConnectedRepoFetchMock([page1, page2]);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);

    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");

    await user.click(screen.getByText("MNIKevin202/DeploymentPlatformInstaller"));

    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");
  });

  test("has a repository search input", async () => {
    const user = userEvent.setup();
    installConnectedRepoFetchMock([[{ id: "1", owner: "MNIKevin202", name: "repo-a" }]]);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);

    await screen.findByPlaceholderText("Search by name, owner, or owner/repo...");
  });

  test("search matches repository name, owner, and full name, case-insensitively", async () => {
    const user = userEvent.setup();
    const page1 = Array.from({ length: 20 }, (_, i) => ({ id: String(i), owner: "MNIKevin202", name: `repo-${i}` }));
    const page2 = [{ id: "target", owner: "a-different-owner", name: "SpecialRepo" }];
    installConnectedRepoFetchMock([page1, page2]);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);

    await screen.findByText("a-different-owner/SpecialRepo");

    const search = screen.getByPlaceholderText("Search by name, owner, or owner/repo...");
    await user.type(search, "specialrepo");

    await waitFor(() => {
      expect(screen.getByText("a-different-owner/SpecialRepo")).toBeInTheDocument();
      expect(screen.queryByText("MNIKevin202/repo-0")).not.toBeInTheDocument();
    });

    await user.clear(search);
    await user.type(search, "A-DIFFERENT-OWNER");
    await waitFor(() => {
      expect(screen.getByText("a-different-owner/SpecialRepo")).toBeInTheDocument();
    });
  });

  test("clearing the search restores the complete repository list", async () => {
    const user = userEvent.setup();
    installConnectedRepoFetchMock([
      [
        { id: "1", owner: "MNIKevin202", name: "alpha" },
        { id: "2", owner: "MNIKevin202", name: "beta" }
      ]
    ]);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);

    await screen.findByText("MNIKevin202/alpha");
    await screen.findByText("MNIKevin202/beta");

    const search = screen.getByPlaceholderText("Search by name, owner, or owner/repo...");
    await user.type(search, "alpha");
    await waitFor(() => expect(screen.queryByText("MNIKevin202/beta")).not.toBeInTheDocument());

    await user.clear(search);
    await waitFor(() => {
      expect(screen.getByText("MNIKevin202/alpha")).toBeInTheDocument();
      expect(screen.getByText("MNIKevin202/beta")).toBeInTheDocument();
    });
  });

  test("the selected repository survives navigating forward and back through the wizard", async () => {
    const user = userEvent.setup();
    installConnectedRepoFetchMock([[{ id: "1", owner: "MNIKevin202", name: "DeploymentPlatformInstaller" }]]);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);

    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");
    await user.click(screen.getByText("MNIKevin202/DeploymentPlatformInstaller"));
    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");

    // Inspection now runs automatically once a repo + branch are selected.
    await screen.findByRole("button", { name: "Re-inspect Repository" });
    await screen.findByText("Dockerfile path");

    // Forward to Basics, then back to Source.
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByPlaceholderText("hello-nginx");
    await user.click(screen.getByRole("button", { name: "Back" }));

    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");
  });

  test("loading state is shown while the first page is in flight", async () => {
    const user = userEvent.setup();
    let resolveRepos: ((value: Response) => void) | null = null;
    const loadingImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/environment/global") return jsonResponse(200, { variables: [] });
      if (url === "/api/integrations/github") return jsonResponse(200, { connected: false });
      if (url === "/api/github/installations") {
        return jsonResponse(200, { success: true, configured: true, installations: [{ installationId: 555 }] });
      }
      if (url.startsWith("/api/integrations/github/repositories")) {
        return new Promise<Response>((resolve) => {
          resolveRepos = resolve;
        });
      }
      throw new Error(`Unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", loadingImpl);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);
    await screen.findByText("Loading repositories...");

    resolveRepos!(jsonResponse(200, { success: true, repositories: [], hasMore: false, source: "installation" }));
    await screen.findByText("No accessible repositories were found.");
  });

  test("empty state is shown when zero repositories are accessible", async () => {
    const user = userEvent.setup();
    installConnectedRepoFetchMock([[]]);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);

    await screen.findByText("No accessible repositories were found.");
  });

  test("no-results state is shown when search matches nothing, distinct from empty", async () => {
    const user = userEvent.setup();
    installConnectedRepoFetchMock([[{ id: "1", owner: "MNIKevin202", name: "only-repo" }]]);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);
    await screen.findByText("MNIKevin202/only-repo");

    await user.type(
      screen.getByPlaceholderText("Search by name, owner, or owner/repo..."),
      "nothing-will-match-this"
    );

    await screen.findByText("No repositories match this search.");
    expect(screen.queryByText("No accessible repositories were found.")).not.toBeInTheDocument();
  });

  test("error state is shown distinctly on a GitHub connection failure", async () => {
    const user = userEvent.setup();
    const errorImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/environment/global") return jsonResponse(200, { variables: [] });
      if (url === "/api/integrations/github") return jsonResponse(200, { connected: false });
      if (url === "/api/github/installations") {
        return jsonResponse(200, { success: true, configured: true, installations: [{ installationId: 555 }] });
      }
      if (url.startsWith("/api/integrations/github/repositories")) {
        return jsonResponse(409, { success: false, message: "GitHub is not connected." });
      }
      throw new Error(`Unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", errorImpl);

    render(<CreateAppWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    await goToSourceStepAndSelectGithub(user);

    await screen.findByText("GitHub is not connected.");
    expect(screen.queryByText("No accessible repositories were found.")).not.toBeInTheDocument();
  });
});
