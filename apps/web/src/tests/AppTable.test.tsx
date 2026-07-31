import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AppTable from "../components/AppTable";
import type { ContainerSummary, StoredApp } from "../types/api";

function container(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: "container-1",
    shortId: "container-1".slice(0, 12),
    names: ["app-example"],
    image: "postgres:16-alpine",
    state: "running",
    status: "Up 2 minutes",
    created: 0,
    ports: [],
    labels: { "com.deployment-platform.app-name": "example" },
    isSystemContainer: false,
    isManagedApp: true,
    ...overrides
  };
}

function storedApp(overrides: Partial<StoredApp> = {}): StoredApp {
  return {
    id: 1,
    name: "example",
    containerId: "container-1",
    containerName: "app-example",
    image: "postgres:16-alpine",
    containerPort: 5432,
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
    ...overrides
  };
}

const noop = {
  onAction: vi.fn(),
  onOpenLogs: vi.fn(),
  onDeleteApp: vi.fn(),
  onDeleteMissingApp: vi.fn(),
  onViewApp: vi.fn()
};

describe("AppTable — Update column", () => {
  test("shows an Update Available badge when the app has one", () => {
    const app = storedApp({ imageUpdateAvailable: true });
    render(
      <AppTable
        managedApps={[container()]}
        storedAppsByName={new Map([["example", app]])}
        missingApps={[]}
        actionLoading={null}
        {...noop}
      />
    );

    expect(screen.getByText("Update Available")).toBeInTheDocument();
  });

  test("shows a dash when no update is available", () => {
    const app = storedApp({ imageUpdateAvailable: false });
    render(
      <AppTable
        managedApps={[container()]}
        storedAppsByName={new Map([["example", app]])}
        missingApps={[]}
        actionLoading={null}
        {...noop}
      />
    );

    expect(screen.queryByText("Update Available")).not.toBeInTheDocument();
  });
});
