import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppsPage from "../pages/AppsPage";
import type { StoredApp } from "../types/api";

function missingApp(overrides: Partial<StoredApp> = {}): StoredApp {
  return {
    id: 6,
    name: "roadmapstudio-web",
    containerId: null,
    containerName: "app-roadmapstudio-web",
    image: "nginx:alpine",
    containerPort: 4319,
    domain: "roadmapstudio.xyz",
    internalOnly: false,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    memoryLimitMb: null,
    cpuLimit: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDeployedAt: null,
    routingReady: true,
    health: null,
    latestEventSeverity: null,
    runtime: { present: false, running: false, status: null },
    ...overrides
  };
}

function renderPage(overrides: Partial<Parameters<typeof AppsPage>[0]> = {}) {
  const props = {
    managedApps: [],
    storedAppsByName: new Map<string, StoredApp>(),
    missingApps: [missingApp()],
    actionLoading: null,
    onAction: vi.fn(),
    onOpenLogs: vi.fn(),
    onDeleteApp: vi.fn(),
    onDeleteMissingApp: vi.fn(),
    onViewApp: vi.fn(),
    onCreateApp: vi.fn(),
    ...overrides
  };
  render(<AppsPage {...props} />);
  return props;
}

describe("AppsPage — missing-container app visibility", () => {
  test("a database-managed app with no container stays listed in a recovery state, not hidden", () => {
    renderPage();

    expect(screen.getByText("app-roadmapstudio-web")).toBeInTheDocument();
    expect(screen.getByText("Recovery required")).toBeInTheDocument();
    expect(screen.getByText("missing")).toBeInTheDocument();
  });

  test("the stale database 'running' status is never shown for a missing container", () => {
    renderPage();

    // Even though status/desiredStatus say "running", the card must not
    // present the app as running.
    expect(screen.queryByText("running")).not.toBeInTheDocument();
  });

  test("View App remains available and opens the app detail (where Source/Deploy live)", async () => {
    const user = userEvent.setup();
    const props = renderPage();

    await user.click(screen.getByRole("button", { name: "View App" }));
    expect(props.onViewApp).toHaveBeenCalledTimes(1);
    expect(props.onViewApp).toHaveBeenCalledWith(expect.objectContaining({ id: 6 }));
  });

  test("Delete remains available for a missing-container app", async () => {
    const user = userEvent.setup();
    const props = renderPage();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.onDeleteMissingApp).toHaveBeenCalledTimes(1);
    expect(props.onDeleteMissingApp).toHaveBeenCalledWith(expect.objectContaining({ id: 6 }));
  });

  test("the empty state is not shown when the only apps present are missing-container ones", () => {
    renderPage();
    expect(screen.queryByText("No managed apps yet")).not.toBeInTheDocument();
  });
});
