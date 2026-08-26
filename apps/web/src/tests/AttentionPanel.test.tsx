import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AttentionPanel from "../components/AttentionPanel";
import type { AttentionItem } from "../lib/platformHealth";
import type { StoredApp } from "../types/api";

function fakeApp(id: number, name: string): StoredApp {
  return { id, name } as StoredApp;
}

function item(overrides: Partial<AttentionItem> & { id: string }): AttentionItem {
  return {
    severity: "warning",
    category: "stopped-app",
    message: "Something needs attention.",
    ...overrides
  } as AttentionItem;
}

describe("AttentionPanel", () => {
  test("shows an all-clear message when there are no items", () => {
    render(<AttentionPanel items={[]} onViewApp={vi.fn()} />);
    expect(screen.getByText(/All clear/)).toBeInTheDocument();
  });

  test("renders an item's message with the correct severity class", () => {
    const items = [item({ id: "a", severity: "critical", message: "Disk is 95% full." })];
    render(<AttentionPanel items={items} onViewApp={vi.fn()} />);

    const message = screen.getByText("Disk is 95% full.");
    expect(message.closest(".attention-item")).toHaveClass("severity-critical");
  });

  test("a per-app item shows a View app button that calls onViewApp with that app", async () => {
    const app = fakeApp(7, "worker");
    const onViewApp = vi.fn();
    const items = [item({ id: "a", message: "worker is stopped.", app })];
    render(<AttentionPanel items={items} onViewApp={onViewApp} />);

    await userEvent.click(screen.getByRole("button", { name: "View app →" }));
    expect(onViewApp).toHaveBeenCalledWith(app);
  });

  test("renders a quick action button when an item has a matching action", async () => {
    const app = fakeApp(7, "worker");
    const onQuickAction = vi.fn();
    const target = item({ id: "a", message: "worker is stopped.", app });
    render(
      <AttentionPanel
        items={[target]}
        onViewApp={vi.fn()}
        onQuickAction={onQuickAction}
        getQuickActionLabel={() => "Start"}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onQuickAction).toHaveBeenCalledWith(target);
  });

  test("shows a disabled loading state for a running quick action", () => {
    const app = fakeApp(7, "worker");
    const target = item({ id: "a", message: "worker is stopped.", app });
    render(
      <AttentionPanel
        items={[target]}
        onViewApp={vi.fn()}
        onQuickAction={vi.fn()}
        getQuickActionLabel={() => "Redeploy"}
        isQuickActionLoading={() => true}
      />
    );

    expect(screen.getByRole("button", { name: "Redeploy..." })).toBeDisabled();
  });

  test("renders a don't show again button that dismisses the item", async () => {
    const app = fakeApp(7, "worker");
    const onDismissItem = vi.fn();
    const target = item({ id: "a", message: "worker is stopped.", app });
    render(<AttentionPanel items={[target]} onViewApp={vi.fn()} onDismissItem={onDismissItem} />);

    await userEvent.click(screen.getByRole("button", { name: "Don't show again" }));
    expect(onDismissItem).toHaveBeenCalledWith(target);
  });

  test("a platform-wide item (no app) renders without a View app button", () => {
    const items = [item({ id: "a", message: "Disk is 92% full." })];
    render(<AttentionPanel items={items} onViewApp={vi.fn()} />);

    expect(screen.getByText("Disk is 92% full.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View app →" })).not.toBeInTheDocument();
  });

  test("critical items are sorted ahead of warnings", () => {
    const items = [
      item({ id: "w", severity: "warning", message: "Warning message" }),
      item({ id: "c", severity: "critical", message: "Critical message" })
    ];
    render(<AttentionPanel items={items} onViewApp={vi.fn()} />);

    const messages = screen.getAllByText(/message/).map((el) => el.textContent);
    expect(messages).toEqual(["Critical message", "Warning message"]);
  });

  test("caps visible items at 10 and shows a +N more note", () => {
    const items = Array.from({ length: 13 }, (_, i) => item({ id: `item-${i}`, message: `Item ${i}` }));
    render(<AttentionPanel items={items} onViewApp={vi.fn()} />);

    expect(screen.getAllByText(/^Item \d+$/)).toHaveLength(10);
    expect(screen.getByText("+3 more")).toBeInTheDocument();
  });
});
