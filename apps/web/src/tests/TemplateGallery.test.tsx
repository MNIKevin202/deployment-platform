import { describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TemplateGallery from "../components/TemplateGallery";

describe("TemplateGallery", () => {
  test("renders nothing when closed", () => {
    const { container } = render(
      <TemplateGallery
        open={false}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        storedApps={[]}
        onViewApp={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("opens a template's detail view, then installs it", async () => {
    const onSelect = vi.fn();
    render(
      <TemplateGallery
        open
        onClose={vi.fn()}
        onSelect={onSelect}
        storedApps={[]}
        onViewApp={vi.fn()}
      />
    );

    expect(screen.getByText("One-click templates")).toBeInTheDocument();

    // Clicking a card opens its detail view rather than installing immediately.
    await userEvent.click(screen.getByText("PostgreSQL").closest("button")!);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("postgres:16-alpine")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Install PostgreSQL/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe("postgres");
  });

  test("back returns to the grid without selecting", async () => {
    const onSelect = vi.fn();
    render(
      <TemplateGallery
        open
        onClose={vi.fn()}
        onSelect={onSelect}
        storedApps={[]}
        onViewApp={vi.fn()}
      />
    );

    await userEvent.click(screen.getByText("Redis").closest("button")!);
    await userEvent.click(screen.getByRole("button", { name: /Back/ }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("One-click templates")).toBeInTheDocument();
  });

  test("marks a card Installed when an existing app runs the same image, and offers to view it", async () => {
    const onViewApp = vi.fn();
    render(
      <TemplateGallery
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        storedApps={[{ id: 7, name: "my-postgres", image: "postgres:15-alpine" }]}
        onViewApp={onViewApp}
      />
    );

    const postgresCard = screen.getByText("PostgreSQL").closest("button")!;
    expect(within(postgresCard).getByText("Installed")).toBeInTheDocument();

    // Redis has no matching app, so no badge.
    const redisCard = screen.getByText("Redis").closest("button")!;
    expect(within(redisCard).queryByText("Installed")).not.toBeInTheDocument();

    await userEvent.click(postgresCard);
    expect(screen.getByText(/Already installed as/)).toBeInTheDocument();
    expect(screen.getByText("my-postgres")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "View App" }));
    expect(onViewApp).toHaveBeenCalledWith(7);

    // Install stays available even when already installed (a second instance is valid).
    expect(screen.getByRole("button", { name: /Install PostgreSQL/ })).toBeInTheDocument();
  });
});
