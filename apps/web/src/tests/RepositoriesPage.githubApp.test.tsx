import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RepositoriesPage from "../pages/RepositoriesPage";

interface FetchLog {
  url: string;
  init?: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

interface MockState {
  configured: boolean;
  missing?: string[];
  installations: Array<{
    installationId: number;
    accountLogin: string;
    accountType: string;
    targetType: string;
    repositorySelection: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

function installFetchMock(state: MockState) {
  const calls: FetchLog[] = [];

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url === "/api/integrations/github") {
      return jsonResponse(200, { success: true, connected: false, provider: "github", username: null, lastValidatedAt: null, credentialStatus: "not-configured", permissions: null, setupRequired: false });
    }
    if (url === "/api/github/installations") {
      return jsonResponse(200, {
        success: true,
        configured: state.configured,
        ...(state.missing ? { missing: state.missing } : {}),
        installations: state.installations
      });
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
    if (url === "/api/github/disconnect") {
      return jsonResponse(200, { success: true });
    }

    throw new Error(`Unhandled fetch in test: ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return { calls, impl };
}

describe("RepositoriesPage — GitHub App connect/connected states", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  test("not configured: shows a 'not configured' message, no Connect button", async () => {
    installFetchMock({ configured: false, missing: ["GITHUB_APP_ID"], installations: [] });

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);

    await screen.findByText(/not been configured on this server/);
    expect(screen.queryByRole("link", { name: "Connect GitHub" })).not.toBeInTheDocument();
  });

  test("configured, no installation: shows the primary Connect GitHub action", async () => {
    installFetchMock({ configured: true, installations: [] });

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);

    const connectLink = await screen.findByRole("link", { name: "Connect GitHub" });
    expect(connectLink).toHaveAttribute("href", "/api/github/connect");
    expect(
      screen.getByText(/Authorize selected repositories through GitHub\. No password or manual token is required\./)
    ).toBeInTheDocument();
  });

  test("connected: shows account, installation id, and loads repositories automatically", async () => {
    installFetchMock({
      configured: true,
      installations: [
        {
          installationId: 555,
          accountLogin: "MNIKevin202",
          accountType: "User",
          targetType: "User",
          repositorySelection: "selected",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);

    await screen.findByText("MNIKevin202");
    expect(screen.getByText("#555")).toBeInTheDocument();
    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");
    expect(screen.getByRole("button", { name: "Refresh repositories" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage access on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/settings/installations/555"
    );
  });

  test("an organization installation links to the organization's manage-access page", async () => {
    installFetchMock({
      configured: true,
      installations: [
        {
          installationId: 777,
          accountLogin: "my-org",
          accountType: "Organization",
          targetType: "Organization",
          repositorySelection: "all",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);

    const link = await screen.findByRole("link", { name: "Manage access on GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/organizations/my-org/settings/installations/777");
  });

  test("disconnect posts to /api/github/disconnect with the installation id and clears the connected state", async () => {
    const user = userEvent.setup();
    const { calls } = installFetchMock({
      configured: true,
      installations: [
        {
          installationId: 555,
          accountLogin: "MNIKevin202",
          accountType: "User",
          targetType: "User",
          repositorySelection: "selected",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);
    await screen.findByText("MNIKevin202");

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialogConfirm = screen.getAllByRole("button", { name: "Disconnect" });
    await user.click(dialogConfirm[dialogConfirm.length - 1]!);

    await waitFor(() => {
      const disconnectCall = calls.find((c) => c.url === "/api/github/disconnect");
      expect(disconnectCall).toBeDefined();
      expect(JSON.parse(disconnectCall!.init!.body as string)).toEqual({ installationId: 555 });
    });
  });

  test("a github=connected callback result shows a notice and strips the query string", async () => {
    window.history.replaceState(null, "", "/?section=repositories&github=connected&installation=555");
    installFetchMock({ configured: true, installations: [] });

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);

    await screen.findByText(/GitHub connected \(installation #555\)/);
    expect(window.location.search).toBe("");
  });

  test("a github=error callback result shows the error message", async () => {
    window.history.replaceState(
      null,
      "",
      "/?section=repositories&github=error&message=Authorization%20failed"
    );
    installFetchMock({ configured: true, installations: [] });

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);

    await screen.findByText("Authorization failed");
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
    private: false,
    archived: false,
    description: null,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${repo.owner}/${repo.name}`,
    pushedAt: null,
    updatedAt: null
  };
}

const CONNECTED_STATE: MockState = {
  configured: true,
  installations: [
    {
      installationId: 555,
      accountLogin: "MNIKevin202",
      accountType: "User",
      targetType: "User",
      repositorySelection: "selected",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ]
};

/** Serves two distinct pages from /api/integrations/github/repositories, in request order, ignoring the requested page number — enough to exercise full auto-pagination. */
function installMultiPageFetchMock(pages: RepoFixture[][]) {
  const calls: FetchLog[] = [];
  let pageIndex = 0;

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url === "/api/integrations/github") {
      return jsonResponse(200, { success: true, connected: false, provider: "github", username: null, lastValidatedAt: null, credentialStatus: "not-configured", permissions: null, setupRequired: false });
    }
    if (url === "/api/github/installations") {
      return jsonResponse(200, { success: true, configured: true, installations: CONNECTED_STATE.installations });
    }
    if (url.startsWith("/api/integrations/github/repositories")) {
      const items = pages[pageIndex] ?? [];
      const hasMore = pageIndex < pages.length - 1;
      pageIndex += 1;
      return jsonResponse(200, {
        success: true,
        repositories: items.map(repoBody),
        hasMore,
        source: "installation"
      });
    }

    throw new Error(`Unhandled fetch in test: ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return { calls, impl, resetPageIndex: () => { pageIndex = 0; } };
}

describe("RepositoriesPage — full pagination and search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  test("search finds a repository from a later page without clicking Load More", async () => {
    const user = userEvent.setup();
    const page1 = Array.from({ length: 20 }, (_, i) => ({ id: String(i), owner: "MNIKevin202", name: `repo-${i}` }));
    const page2 = [{ id: "target", owner: "MNIKevin202", name: "DeploymentPlatformInstaller" }];
    installMultiPageFetchMock([page1, page2]);

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);

    await screen.findByText("MNIKevin202/repo-0");
    await screen.findByText("MNIKevin202/DeploymentPlatformInstaller");

    expect(screen.queryByText(/No repositories match this filter/)).not.toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Search all repositories by name..."),
      "DeploymentPlatformInstaller"
    );

    await waitFor(() => {
      expect(screen.getByText("MNIKevin202/DeploymentPlatformInstaller")).toBeInTheDocument();
      expect(screen.queryByText("MNIKevin202/repo-0")).not.toBeInTheDocument();
    });
  });

  test("owner filtering works for repositories on a later page", async () => {
    const user = userEvent.setup();
    const page1 = Array.from({ length: 20 }, (_, i) => ({ id: String(i), owner: "MNIKevin202", name: `repo-${i}` }));
    const page2 = [{ id: "target", owner: "a-different-owner", name: "some-repo" }];
    installMultiPageFetchMock([page1, page2]);

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);

    await screen.findByText("a-different-owner/some-repo");

    await user.type(screen.getByPlaceholderText("Filter all repositories by owner..."), "a-different-owner");

    await waitFor(() => {
      expect(screen.getByText("a-different-owner/some-repo")).toBeInTheDocument();
      expect(screen.queryByText("MNIKevin202/repo-0")).not.toBeInTheDocument();
    });
  });

  test("Refresh restarts pagination and replaces stale results with a fresh complete list", async () => {
    const user = userEvent.setup();
    const initialPages = [[{ id: "1", owner: "MNIKevin202", name: "old-repo" }]];
    const { impl } = installMultiPageFetchMock(initialPages);

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);
    await screen.findByText("MNIKevin202/old-repo");

    vi.mocked(impl).mockClear();
    vi.unstubAllGlobals();
    installMultiPageFetchMock([[{ id: "2", owner: "MNIKevin202", name: "new-repo" }]]);

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(screen.getByText("MNIKevin202/new-repo")).toBeInTheDocument();
      expect(screen.queryByText("MNIKevin202/old-repo")).not.toBeInTheDocument();
    });
  });

  test("shows the total number of repositories loaded once pagination completes", async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => ({ id: String(i), owner: "MNIKevin202", name: `repo-${i}` }));
    const page2 = [{ id: "20", owner: "MNIKevin202", name: "repo-20" }];
    installMultiPageFetchMock([page1, page2]);

    render(<RepositoriesPage onSelectRepository={vi.fn()} />);

    await screen.findByText("21 repositories loaded");
  });
});
