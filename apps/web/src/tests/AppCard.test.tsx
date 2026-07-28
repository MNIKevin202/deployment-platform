import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AppCard from "../components/AppCard";
import type { ContainerSummary, StoredApp } from "../types/api";

function container(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: "container-1",
    shortId: "container-1".slice(0, 12),
    names: ["app-roadmapstudio-postgres"],
    image: "postgres:16-alpine",
    state: "running",
    status: "Up 2 minutes",
    created: 0,
    ports: [],
    labels: {},
    isSystemContainer: false,
    isManagedApp: true,
    ...overrides
  };
}

function storedApp(overrides: Partial<StoredApp> = {}): StoredApp {
  return {
    id: 1,
    name: "roadmapstudio-postgres",
    containerId: "container-1",
    containerName: "app-roadmapstudio-postgres",
    image: "postgres:16-alpine",
    containerPort: 5432,
    domain: null,
    internalOnly: true,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDeployedAt: "2026-01-01T00:00:00.000Z",
    routingReady: false,
    health: null,
    latestEventSeverity: null,
    ...overrides
  };
}

describe("AppCard — internal-only vs public display", () => {
  test("an internal-only app shows an 'Internal only' badge and no Open App button", () => {
    render(
      <AppCard
        container={container()}
        storedApp={storedApp()}
        actionLoading={null}
        onAction={vi.fn()}
        onOpenLogs={vi.fn()}
      />
    );

    expect(screen.getByText("Internal only")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open App" })).not.toBeInTheDocument();
    // The app is still fully manageable.
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Logs" })).toBeInTheDocument();
  });

  test("a public, routed app shows its domain and an Open App button", () => {
    render(
      <AppCard
        container={container({ names: ["app-roadmapstudio-web"] })}
        storedApp={storedApp({
          name: "roadmapstudio-web",
          containerName: "app-roadmapstudio-web",
          domain: "roadmapstudio.xyz",
          internalOnly: false,
          routingReady: true
        })}
        actionLoading={null}
        onAction={vi.fn()}
        onOpenLogs={vi.fn()}
      />
    );

    expect(screen.getByText("roadmapstudio.xyz")).toBeInTheDocument();
    expect(screen.queryByText("Internal only")).not.toBeInTheDocument();
    const openAppLink = screen.getByRole("link", { name: "Open App" });
    expect(openAppLink).toHaveAttribute("href", "https://roadmapstudio.xyz");
  });

  test("a public app whose routing isn't active yet shows the domain but no Open App button", () => {
    render(
      <AppCard
        container={container()}
        storedApp={storedApp({
          domain: "roadmapstudio.xyz",
          internalOnly: false,
          routingReady: false
        })}
        actionLoading={null}
        onAction={vi.fn()}
        onOpenLogs={vi.fn()}
      />
    );

    expect(screen.getByText("roadmapstudio.xyz")).toBeInTheDocument();
    expect(screen.getByText("Routing not yet active")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open App" })).not.toBeInTheDocument();
  });
});
