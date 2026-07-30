import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DomainDialog from "../components/DomainDialog";

function renderDialog(
  overrides: Partial<{
    currentDomain: string | null;
    currentInternalOnly: boolean;
  }> = {},
  onSubmit = vi.fn()
) {
  render(
    <DomainDialog
      open
      currentDomain={overrides.currentDomain ?? null}
      currentInternalOnly={overrides.currentInternalOnly ?? false}
      submitting={false}
      error=""
      onSubmit={onSubmit}
      onCancel={() => {}}
    />
  );
  return onSubmit;
}

describe("DomainDialog", () => {
  test("a public app with no domain defaults to the generated-domain choice and submits with no customDomain", () => {
    const onSubmit = renderDialog({ currentDomain: null, currentInternalOnly: false });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      internalOnly: false,
      customDomain: undefined
    });
  });

  test("a public app with an existing custom domain pre-fills it and resubmits unchanged", () => {
    const onSubmit = renderDialog({
      currentDomain: "roadmapstudio.xyz",
      currentInternalOnly: false
    });

    expect(screen.getByDisplayValue("roadmapstudio.xyz")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      internalOnly: false,
      customDomain: "roadmapstudio.xyz"
    });
  });

  test("switching to internal-only submits internalOnly:true with no customDomain", () => {
    const onSubmit = renderDialog({
      currentDomain: "roadmapstudio.xyz",
      currentInternalOnly: false
    });

    fireEvent.click(screen.getByText(/Internal-only app/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      internalOnly: true,
      customDomain: undefined
    });
  });

  test("switching an internal-only app to public with a new custom domain", () => {
    const onSubmit = renderDialog({ currentDomain: null, currentInternalOnly: true });

    fireEvent.click(screen.getByText(/^Public app/));
    fireEvent.click(screen.getByText("Use a custom domain"));
    fireEvent.change(screen.getByPlaceholderText("roadmapstudio.xyz"), {
      target: { value: "example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      internalOnly: false,
      customDomain: "example.com"
    });
  });

  test("switching back to the generated domain clears a previously custom domain on submit", () => {
    const onSubmit = renderDialog({
      currentDomain: "roadmapstudio.xyz",
      currentInternalOnly: false
    });

    fireEvent.click(screen.getByText("Use the platform's generated domain"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({
      internalOnly: false,
      customDomain: undefined
    });
  });

  test("disables Save for an invalid custom domain", () => {
    renderDialog({ currentDomain: null, currentInternalOnly: false });

    fireEvent.click(screen.getByText("Use a custom domain"));
    fireEvent.change(screen.getByPlaceholderText("roadmapstudio.xyz"), {
      target: { value: "not a domain" }
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  test("disables Save for an empty custom domain", () => {
    renderDialog({ currentDomain: null, currentInternalOnly: false });

    fireEvent.click(screen.getByText("Use a custom domain"));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
