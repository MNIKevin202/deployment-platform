import { beforeEach, describe, expect, test, vi } from "vitest";
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

describe("AppsPage — grid/table view toggle", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("defaults to grid, switches to table, and persists the choice", async () => {
    render(<AppsPage {...baseProps()} />);

    // Grid is the default: the card view, no table yet.
    expect(screen.getByRole("button", { name: /Grid/ })).toHaveClass("active");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Table/ }));

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Table/ })).toHaveClass("active");
    expect(localStorage.getItem("dp_apps_view")).toBe("table");
  });

  test("restores a persisted table preference on mount", () => {
    localStorage.setItem("dp_apps_view", "table");
    render(<AppsPage {...baseProps()} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  test("the table lists the app and can trigger actions", async () => {
    const onOpenLogs = vi.fn();
    localStorage.setItem("dp_apps_view", "table");
    render(<AppsPage {...baseProps({ onOpenLogs })} />);

    expect(screen.getByText("app-web")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(onOpenLogs).toHaveBeenCalledTimes(1);
  });
});
