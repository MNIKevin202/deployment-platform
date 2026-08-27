import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppsPage from "../pages/AppsPage";
import type { ContainerSummary, StoredApp } from "../types/api";

function container(
  id: string,
  name: string,
  state: string
): ContainerSummary {
  return {
    id,
    shortId: id,
    names: [`/app-${name}`],
    image: "nginx:alpine",
    state,
    status: state === "running" ? "Up 2 hours" : "Exited",
    created: 0,
    ports: [],
    labels: { "com.deployment-platform.app-name": name },
    isSystemContainer: false,
    isManagedApp: true
  };
}

function storedApp(id: number, name: string): StoredApp {
  return {
    id,
    name,
    containerId: null,
    containerName: `app-${name}`,
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
    latestEventType: null
  } as StoredApp;
}

function props() {
  const web = storedApp(1, "web");
  const worker = storedApp(2, "worker");
  const missing = storedApp(3, "missing");
  missing.runtime = { present: false } as StoredApp["runtime"];

  return {
    managedApps: [
      container("c-web", "web", "running"),
      container("c-worker", "worker", "exited")
    ],
    storedAppsByName: new Map([
      ["web", web],
      ["worker", worker]
    ]),
    missingApps: [missing],
    actionLoading: null,
    onAction: vi.fn(),
    onOpenLogs: vi.fn(),
    onDeleteApp: vi.fn(),
    onDeleteMissingApp: vi.fn(),
    onViewApp: vi.fn(),
    onCreateApp: vi.fn(),
    onBulkAction: vi.fn(async () => true),
    onBulkDelete: vi.fn(async () => true)
  };
}

describe("AppsPage — bulk actions", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("dp_apps_view", "table");
  });

  test("starts only stopped apps and stops only running apps", async () => {
    const pageProps = props();
    const user = userEvent.setup();
    render(<AppsPage {...pageProps} />);

    await user.click(screen.getByRole("checkbox", { name: "Select web" }));
    await user.click(screen.getByRole("checkbox", { name: "Select worker" }));

    const toolbar = screen.getByRole("toolbar", { name: "Bulk app actions" });
    expect(within(toolbar).getByText("2 apps selected")).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Start (1)" })).toBeEnabled();
    expect(within(toolbar).getByRole("button", { name: "Stop (1)" })).toBeEnabled();

    await user.click(within(toolbar).getByRole("button", { name: "Start (1)" }));
    expect(pageProps.onBulkAction).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "c-worker" })],
      "start"
    );
    expect(screen.queryByRole("toolbar", { name: "Bulk app actions" })).not.toBeInTheDocument();
  });

  test("bulk delete includes live and missing selected apps", async () => {
    const pageProps = props();
    const user = userEvent.setup();
    render(<AppsPage {...pageProps} />);

    await user.click(screen.getByRole("checkbox", { name: "Select web" }));
    await user.click(screen.getByRole("checkbox", { name: "Select missing" }));
    await user.click(screen.getByRole("button", { name: "Delete (2)" }));

    expect(pageProps.onBulkDelete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "c-web" })],
      [expect.objectContaining({ id: 3, name: "missing" })]
    );
  });

  test("select all applies to the visible filtered apps", async () => {
    const pageProps = props();
    const user = userEvent.setup();
    render(<AppsPage {...pageProps} />);

    await user.type(screen.getByLabelText("Search apps"), "worker");
    await user.click(screen.getByRole("checkbox", { name: "Select all visible apps" }));

    expect(screen.getByText("1 app selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start (1)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop (0)" })).toBeDisabled();
  });

  test("selection is also available in grid view", async () => {
    localStorage.setItem("dp_apps_view", "grid");
    const user = userEvent.setup();
    render(<AppsPage {...props()} />);

    await user.click(screen.getByRole("checkbox", { name: "Select web" }));
    expect(screen.getByText("1 app selected")).toBeInTheDocument();
  });
});
