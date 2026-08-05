import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppsPage from "../pages/AppsPage";
import type { ContainerSummary, StoredApp } from "../types/api";

function container(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: `c-${Math.random()}`,
    shortId: "c1",
    names: ["/app"],
    image: "nginx:alpine",
    state: "running",
    status: "Up 2 hours",
    created: 0,
    ports: [],
    labels: {},
    isSystemContainer: false,
    isManagedApp: true,
    ...overrides
  };
}

function storedApp(overrides: Partial<StoredApp> & { id: number; name: string }): StoredApp {
  return {
    containerId: null,
    containerName: `app-${overrides.name}`,
    image: "nginx:alpine",
    containerPort: 3000,
    domain: null,
    internalOnly: false,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    memoryLimitMb: null,
    cpuLimit: null,
    createdAt: "",
    updatedAt: "",
    lastDeployedAt: null,
    routingReady: true,
    health: null,
    latestEventSeverity: null,
    latestEventType: null,
    ...overrides
  } as StoredApp;
}

function baseProps(overrides: Partial<Parameters<typeof AppsPage>[0]> = {}) {
  const web = storedApp({ id: 1, name: "web" });
  const worker = storedApp({ id: 2, name: "worker" });

  return {
    managedApps: [
      container({ names: ["/app-web"], labels: { "com.deployment-platform.app-name": "web" }, state: "running" }),
      container({ names: ["/app-worker"], labels: { "com.deployment-platform.app-name": "worker" }, state: "exited" })
    ],
    storedAppsByName: new Map([
      ["web", web],
      ["worker", worker]
    ]),
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

describe("AppsPage — filter pills", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("dp_apps_view", "table");
  });

  test("'All' is active by default and shows the total count", () => {
    render(<AppsPage {...baseProps()} />);
    const allPill = screen.getByRole("button", { name: /^All/ });
    expect(allPill).toHaveClass("active");
    expect(allPill).toHaveTextContent("2");
  });

  test("clicking a filter pill narrows the list and shows Clear filters", async () => {
    render(<AppsPage {...baseProps()} />);

    expect(screen.queryByText("Clear filters")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Running/ }));

    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.queryByText("worker")).not.toBeInTheDocument();
    expect(screen.getByText("Clear filters")).toBeInTheDocument();
  });

  test("Clear filters resets back to showing everything", async () => {
    render(<AppsPage {...baseProps()} />);

    await userEvent.click(screen.getByRole("button", { name: /^Running/ }));
    expect(screen.queryByText("worker")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("Clear filters"));

    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^All/ })).toHaveClass("active");
  });

  test("searching also narrows the list and enables Clear filters", async () => {
    render(<AppsPage {...baseProps()} />);

    await userEvent.type(screen.getByLabelText("Search apps"), "worker");

    expect(screen.queryByText("web")).not.toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.getByText("Clear filters")).toBeInTheDocument();
  });
});
