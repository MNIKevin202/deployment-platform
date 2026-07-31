import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TemplateGallery from "../components/TemplateGallery";

describe("TemplateGallery", () => {
  test("renders nothing when closed", () => {
    const { container } = render(<TemplateGallery open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("opens a template's detail view, then installs it", async () => {
    const onSelect = vi.fn();
    render(<TemplateGallery open onClose={vi.fn()} onSelect={onSelect} />);

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
    render(<TemplateGallery open onClose={vi.fn()} onSelect={onSelect} />);

    await userEvent.click(screen.getByText("Redis").closest("button")!);
    await userEvent.click(screen.getByRole("button", { name: /Back/ }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("One-click templates")).toBeInTheDocument();
  });
});
