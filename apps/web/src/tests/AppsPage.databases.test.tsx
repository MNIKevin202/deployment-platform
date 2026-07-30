import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AppsPage from "../pages/AppsPage";
import type { ContainerSummary, StoredApp } from "../types/api";

function container(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: "c1",
    shortId: "c1",
    names: ["/app-roadmapstudio-postgres"],
    image: "postgres:16-alpine",
    state: "running",
    status: "Up 2 hours",
    created: 0,
    ports: [],
    labels: { "com.deployment-platform.app-name": "roadmapstudio-postgres" },
    isSystemContainer: false,
    isManagedApp: true,
    ...overrides
  };
}

function baseProps(overrides: Partial<Parameters<typeof AppsPage>[0]> = {}) {
  return {
    managedApps: [],
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

describe("AppsPage — reused for the Databases section", () => {
  test("renders the custom Databases heading and empty-state copy", () => {
    render(
      <AppsPage
        {...baseProps()}
        eyebrow="Data stores"
        title="Managed Databases"
        emptyTitle="No databases yet"
        emptyBody="Deploy a database (Postgres, MySQL, Redis, …) from a Docker image."
      />
    );

    expect(screen.getByText("Managed Databases")).toBeInTheDocument();
    expect(screen.getByText("Data stores")).toBeInTheDocument();
    expect(screen.getByText("No databases yet")).toBeInTheDocument();
    // The default Apps copy must not appear when overridden.
    expect(screen.queryByText("All Managed Apps")).not.toBeInTheDocument();
    expect(screen.queryByText("No managed apps yet")).not.toBeInTheDocument();
  });

  test("defaults to the Apps heading/empty copy when no overrides are given", () => {
    render(<AppsPage {...baseProps()} />);
    expect(screen.getByText("All Managed Apps")).toBeInTheDocument();
    expect(screen.getByText("No managed apps yet")).toBeInTheDocument();
  });

  test("lists a passed-in database app (App.tsx pre-filters by image)", () => {
    render(<AppsPage {...baseProps({ managedApps: [container()] })} title="Managed Databases" />);
    expect(screen.getByText("Managed Databases")).toBeInTheDocument();
    // The card renders the container's app name.
    expect(screen.getByText(/roadmapstudio-postgres/)).toBeInTheDocument();
  });
});
