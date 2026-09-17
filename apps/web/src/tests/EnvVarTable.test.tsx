import { describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EnvVarTable from "../components/EnvVarTable";
import type { MaskedGlobalEnvVar } from "../types/api";

function envVar(
  overrides: Partial<MaskedGlobalEnvVar> & Pick<MaskedGlobalEnvVar, "id" | "key">
): MaskedGlobalEnvVar {
  return {
    isSecret: false,
    enabled: true,
    hasValue: true,
    value: "value",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

// Eight variables across several prefixes: enough to auto-group and to show
// the search / sort / group toolbar.
const VARIABLES: MaskedGlobalEnvVar[] = [
  envVar({ id: 1, key: "NODE_ENV", value: "production" }),
  envVar({ id: 2, key: "METALS_API_KEY", value: "secretval-123" }),
  envVar({ id: 3, key: "BLUEPRINT_MONGO_URI", value: "mongodb+srv://u:p@host/db" }),
  envVar({ id: 4, key: "BLUEPRINT_CHAT_MODEL", value: "qwen3" }),
  envVar({ id: 5, key: "BLUEPRINT_ENDPOINT", value: "http://host:8792/v1" }),
  envVar({ id: 6, key: "CLOVA_TESTING", value: "true" }),
  envVar({ id: 7, key: "CLOVA_TEST_INSTRUCTIONS", value: "do the thing" }),
  envVar({ id: 8, key: "YUM_CHAT", value: "true" })
];

function renderTable() {
  return render(
    <EnvVarTable
      variables={VARIABLES}
      emptyMessage="No variables"
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

function rowFor(key: string): HTMLElement {
  const row = screen.getByText(key).closest("tr");
  if (!row) {
    throw new Error(`No row for ${key}`);
  }
  return row as HTMLElement;
}

describe("EnvVarTable", () => {
  test("masks a secret-looking value until it is explicitly revealed", async () => {
    const user = userEvent.setup();
    renderTable();

    // The value is never in the DOM while masked.
    expect(screen.queryByText("secretval-123")).toBeNull();

    const row = rowFor("METALS_API_KEY");
    await user.click(within(row).getByRole("button", { name: "Show" }));

    expect(within(row).getByText("secretval-123")).toBeInTheDocument();
  });

  test("masks a value that carries inline connection credentials", () => {
    renderTable();
    // BLUEPRINT_MONGO_URI's key does not look secret, but its value does.
    expect(screen.queryByText("mongodb+srv://u:p@host/db")).toBeNull();
  });

  test("shows a plain, non-secret value directly", () => {
    renderTable();
    expect(within(rowFor("NODE_ENV")).getByText("production")).toBeInTheDocument();
  });

  test("filters the table by key as you type", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.type(screen.getByLabelText("Filter variables"), "CLOVA");

    expect(screen.getByText("CLOVA_TESTING")).toBeInTheDocument();
    expect(screen.queryByText("METALS_API_KEY")).toBeNull();
    expect(screen.queryByText("NODE_ENV")).toBeNull();
  });

  test("groups by key prefix and can be flattened", async () => {
    const user = userEvent.setup();
    renderTable();

    // Grouped by default at this size: a BLUEPRINT group header (exact text,
    // distinct from the BLUEPRINT_* keys) is present.
    expect(screen.getByText("BLUEPRINT", { selector: ".env-group-name" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Group" }));

    // Flattened: the group header is gone but the rows remain.
    expect(screen.queryByText("BLUEPRINT", { selector: ".env-group-name" })).toBeNull();
    expect(screen.getByText("BLUEPRINT_CHAT_MODEL")).toBeInTheDocument();
  });
});
