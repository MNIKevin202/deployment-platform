import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AppTable from "../components/AppTable";
import { DeployProgressContext } from "../lib/deployProgress";
import type { ContainerSummary, DeployProgress, StoredApp } from "../types/api";

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

describe("AppTable — deploy progress", () => {
  function deployProgress(overrides: Partial<DeployProgress> = {}): DeployProgress {
    return {
      appId: 1,
      appName: "example",
      source: "MNIKevin202/Example@main",
      status: "running",
      stage: "building-image",
      stageLabel: "Building image",
      percent: 55,
      step: 8,
      totalSteps: 14,
      detail: "Building image",
      startedAt: "2026-08-01T00:00:00Z",
      finishedAt: null,
      etaSeconds: 60,
      error: null,
      failedStage: null,
      rolledBack: false,
      ...overrides
    };
  }

  test("replaces the status pill with a live progress bar while deploying", () => {
    const app = storedApp({ id: 1 });
    render(
      <DeployProgressContext.Provider value={new Map([[1, deployProgress()]])}>
        <AppTable
          managedApps={[container()]}
          storedAppsByName={new Map([["example", app]])}
          missingApps={[]}
          actionLoading={null}
          {...noop}
        />
      </DeployProgressContext.Provider>
    );

    expect(screen.getByText("Deploying")).toBeInTheDocument();
    expect(screen.getByText("55%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "55");
    // The plain running/stopped pill is not shown while deploying.
    expect(screen.queryByText("running")).not.toBeInTheDocument();
  });

  test("shows the normal status pill when the app is not deploying", () => {
    const app = storedApp({ id: 1 });
    render(
      <DeployProgressContext.Provider value={new Map()}>
        <AppTable
          managedApps={[container()]}
          storedAppsByName={new Map([["example", app]])}
          missingApps={[]}
          actionLoading={null}
          {...noop}
        />
      </DeployProgressContext.Provider>
    );

    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
