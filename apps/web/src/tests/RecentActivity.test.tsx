import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RecentActivity from "../components/RecentActivity";
import type { StoredApp } from "../types/api";

function app(partial: Partial<StoredApp>): StoredApp {
  return {
    id: 1,
    name: "app",
    lastDeployedAt: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestEventType: null,
    latestEventSeverity: null,
    ...partial
  } as StoredApp;
}

describe("RecentActivity", () => {
  test("empty state when no app has an event", () => {
    render(<RecentActivity apps={[app({ latestEventType: null })]} onViewApp={() => {}} />);
    expect(screen.getByText(/No recent deployment activity/i)).toBeInTheDocument();
  });

  test("humanizes event types and shows apps newest-first", () => {
    const apps = [
      app({ id: 1, name: "web", latestEventType: "deploy_succeeded", latestEventSeverity: "info", lastDeployedAt: "2026-10-10T10:00:00.000Z" }),
      app({ id: 2, name: "api", latestEventType: "deploy_failed", latestEventSeverity: "error", lastDeployedAt: "2026-10-12T10:00:00.000Z" })
    ];
    render(<RecentActivity apps={apps} onViewApp={() => {}} />);
    expect(screen.getByText("Deploy succeeded")).toBeInTheDocument();
    expect(screen.getByText("Deploy failed")).toBeInTheDocument();
    // Newest (api, 10-12) should appear before web (10-10).
    const names = screen.getAllByText(/^(web|api)$/).map((n) => n.textContent);
    expect(names[0]).toBe("api");
  });

  test("clicking an entry calls onViewApp with that app", () => {
    const onViewApp = vi.fn();
    const target = app({ id: 7, name: "worker", latestEventType: "started", latestEventSeverity: "info", lastDeployedAt: "2026-10-11T10:00:00.000Z" });
    render(<RecentActivity apps={[target]} onViewApp={onViewApp} />);
    fireEvent.click(screen.getByText("worker"));
    expect(onViewApp).toHaveBeenCalledWith(target);
  });

  test("respects the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      app({ id: i + 1, name: `a${i}`, latestEventType: "started", latestEventSeverity: "info", lastDeployedAt: `2026-10-${10 + (i % 9)}T10:00:00.000Z` })
    );
    render(<RecentActivity apps={many} onViewApp={() => {}} limit={3} />);
    expect(screen.getAllByText("Started")).toHaveLength(3);
  });
});
