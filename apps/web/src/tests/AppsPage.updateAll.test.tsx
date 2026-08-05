import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppsPage from "../pages/AppsPage";
import type { ContainerSummary, StoredApp } from "../types/api";

function container(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: "c1",
    shortId: "c1",
    names: ["/app-web"],
    image: "nginx:alpine",
    state: "running",
    status: "Up 2 hours",
    created: 0,
    ports: [],
    labels: { "com.deployment-platform.app-name": "web" },
    isSystemContainer: false,
    isManagedApp: true,
    ...overrides
  };
}

function storedApp(overrides: Partial<StoredApp> = {}): StoredApp {
  return {
    id: 1,
    name: "web",
    containerId: "c1",
    containerName: "app-web",
    image: "nginx:alpine",
    containerPort: 80,
    domain: null,
    internalOnly: true,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    memoryLimitMb: null,
    cpuLimit: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDeployedAt: "2026-01-01T00:00:00.000Z",
    routingReady: false,
    health: null,
    latestEventSeverity: null,
    latestEventType: null,
    ...overrides
  };
}

function baseProps(overrides: Partial<Parameters<typeof AppsPage>[0]> = {}) {
  return {
    managedApps: [container()],
    storedAppsByName: new Map<string, StoredApp>(),
    missingApps: [],
    actionLoading: null,
    onAction: vi.fn(),
    onOpenLogs: vi.fn(),
    onDeleteApp: vi.fn(),
    onDeleteMissingApp: vi.fn(),
    onViewApp: vi.fn(),
    onCreateApp: vi.fn(),
    ...overrides
  };
}

describe("AppsPage — Update All button", () => {
  test("is hidden when no app has an update available", () => {
    render(<AppsPage {...baseProps({ storedAppsByName: new Map([["web", storedApp()]]), onUpdateAll: vi.fn() })} />);
    expect(screen.queryByRole("button", { name: /Update All/ })).not.toBeInTheDocument();
  });

  test("is hidden when onUpdateAll isn't provided, even if updates are available", () => {
    render(
      <AppsPage
        {...baseProps({ storedAppsByName: new Map([["web", storedApp({ imageUpdateAvailable: true })]]) })}
      />
    );
    expect(screen.queryByRole("button", { name: /Update All/ })).not.toBeInTheDocument();
  });

  test("shows the count and calls onUpdateAll with the managed apps list when clicked", async () => {
    const onUpdateAll = vi.fn();
    render(
      <AppsPage
        {...baseProps({
          storedAppsByName: new Map([["web", storedApp({ imageUpdateAvailable: true })]]),
          onUpdateAll
        })}
      />
    );

    const button = screen.getByRole("button", { name: "Update All (1)" });
    await userEvent.click(button);

    expect(onUpdateAll).toHaveBeenCalledWith([container()]);
  });

  test("is disabled while updateAllLoading is true", () => {
    render(
      <AppsPage
        {...baseProps({
          storedAppsByName: new Map([["web", storedApp({ imageUpdateAvailable: true })]]),
          onUpdateAll: vi.fn(),
          updateAllLoading: true
        })}
      />
    );

    expect(screen.getByRole("button", { name: "Updating..." })).toBeDisabled();
  });
});
