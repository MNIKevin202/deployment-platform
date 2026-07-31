import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TemplateGallery from "../components/TemplateGallery";

describe("TemplateGallery", () => {
  test("renders nothing when closed", () => {
    const { container } = render(<TemplateGallery open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("lists templates and selects one", async () => {
    const onSelect = vi.fn();
    render(<TemplateGallery open onClose={vi.fn()} onSelect={onSelect} />);

    expect(screen.getByText("One-click templates")).toBeInTheDocument();
    expect(screen.getByText("PostgreSQL")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /PostgreSQL/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe("postgres");
  });
});
