import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import BulkEnvVarDialog from "../components/BulkEnvVarDialog";

function renderDialog(
  existingSecrets: ReadonlyMap<string, boolean> = new Map(),
  onSubmit = vi.fn()
) {
  render(
    <BulkEnvVarDialog
      open
      existingSecrets={existingSecrets}
      submitting={false}
      error=""
      onSubmit={onSubmit}
      onCancel={() => {}}
    />
  );
  return onSubmit;
}

function paste(text: string) {
  const textarea = screen.getByPlaceholderText(/mongo=http/);
  fireEvent.change(textarea, { target: { value: text } });
}

describe("BulkEnvVarDialog", () => {
  test("parses KEY=value lines, skipping blanks and # comments", () => {
    renderDialog();
    paste("mongo=http://123456\n\n# a comment\nusername=testing\n");

    expect(screen.getByText("mongo")).toBeInTheDocument();
    expect(screen.getByText("http://123456")).toBeInTheDocument();
    expect(screen.getByText("username")).toBeInTheDocument();
    expect(screen.getByText("testing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apply \(2\)/ })).toBeEnabled();
  });

  test("flags an invalid key and disables Apply", () => {
    renderDialog();
    paste("1BAD=oops");

    expect(screen.getByText(/must start with a letter or underscore/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  test("flags duplicate keys within the same paste and disables Apply", () => {
    renderDialog();
    paste("DUPLICATE=1\nDUPLICATE=2");

    expect(screen.getAllByText(/Duplicate key in this paste/i).length).toBe(2);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  test("defaults an existing secret variable's checkbox to checked, and a new variable's to unchecked", () => {
    renderDialog(new Map([["API_KEY", true]]));
    paste("API_KEY=new-value\nPLAIN=visible");

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].checked).toBe(true); // API_KEY: existing secret
    expect(checkboxes[1].checked).toBe(false); // PLAIN: new variable
  });

  test("submits each variable with its own isSecret, reflecting per-row checkbox toggles", () => {
    const onSubmit = renderDialog(new Map([["API_KEY", true]]));
    paste("API_KEY=new-value\nPLAIN=visible\nNEW_SECRET=hidden");

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // Un-check the pre-checked existing secret (API_KEY), and check the third row (NEW_SECRET).
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[2]);

    fireEvent.click(screen.getByRole("button", { name: /Apply \(3\)/ }));

    expect(onSubmit).toHaveBeenCalledWith([
      { key: "API_KEY", value: "new-value", isSecret: false },
      { key: "PLAIN", value: "visible", isSecret: false },
      { key: "NEW_SECRET", value: "hidden", isSecret: true }
    ]);
  });

  test("strips matching surrounding quotes from a pasted value", () => {
    renderDialog();
    paste('QUOTED="hello world"');

    expect(screen.getByText("hello world")).toBeInTheDocument();
  });
});
