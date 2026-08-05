import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TemplateGallery from "../components/TemplateGallery";
import type { AppTemplate } from "../lib/appTemplates";

const BIG_HOST = { cpuCount: 8, memoryTotalBytes: 16 * 1024 * 1024 * 1024 };
const SMALL_HOST = { cpuCount: 2, memoryTotalBytes: 2 * 1024 * 1024 * 1024 };

function renderGallery(
  overrides: {
    onSelect?: (template: AppTemplate, options?: { model?: string | null }) => void;
    hostInfo?: { cpuCount: number; memoryTotalBytes: number } | null;
  } = {}
) {
  return render(
    <TemplateGallery
      onSelect={overrides.onSelect ?? (() => {})}
      storedApps={[]}
      onViewApp={() => {}}
      hostInfo={overrides.hostInfo ?? BIG_HOST}
    />
  );
}

async function openBlueprint(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Blueprint/ }));
}

describe("TemplateGallery — Blueprint", () => {
  test("lists Blueprint under an AI category with its badge", () => {
    renderGallery();

    expect(screen.getByRole("heading", { name: /^AI/ })).toBeInTheDocument();
    expect(screen.getAllByText("DevMinted Original").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Private AI workspace powered by models running directly on your VPS.")
    ).toBeInTheDocument();
  });

  test("the detail view spells out both services and which one is public", async () => {
    const user = userEvent.setup();
    renderGallery();
    await openBlueprint(user);

    expect(screen.getByText("app-blueprint")).toBeInTheDocument();
    expect(screen.getByText("app-blueprint-ollama")).toBeInTheDocument();
    expect(screen.getByText(/Model server \(Ollama\)/)).toBeInTheDocument();
    expect(screen.getByText(/internal only/)).toBeInTheDocument();
  });

  test("states minimum and recommended resources plus the CPU warning", async () => {
    const user = userEvent.setup();
    renderGallery();
    await openBlueprint(user);

    expect(screen.getByText("Minimum")).toBeInTheDocument();
    expect(screen.getByText(/4 vCPU · 4 GB RAM · 10 GB storage/)).toBeInTheDocument();
    expect(screen.getByText(/6\+ vCPU · 8 GB RAM · 20 GB storage/)).toBeInTheDocument();
    expect(screen.getByText(/runs AI models on your VPS CPU/)).toBeInTheDocument();
  });

  test("warns about an undersized host but still allows installing", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderGallery({ hostInfo: SMALL_HOST, onSelect });
    await openBlueprint(user);

    expect(screen.getByText(/below the minimum this template asks for/)).toBeInTheDocument();

    const install = screen.getByRole("button", { name: "Install Blueprint" });
    expect(install).toBeEnabled();
    await user.click(install);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("shows no host warning on a well-sized server", async () => {
    const user = userEvent.setup();
    renderGallery({ hostInfo: BIG_HOST });
    await openBlueprint(user);

    expect(screen.queryByText(/below the minimum/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not the recommendation/)).not.toBeInTheDocument();
  });

  test("passes the chosen model to the wizard", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderGallery({ onSelect });
    await openBlueprint(user);

    await user.selectOptions(
      screen.getByLabelText("Model to download after install"),
      "llama3.2:1b"
    );
    await user.click(screen.getByRole("button", { name: "Install Blueprint" }));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "blueprint" }),
      { model: "llama3.2:1b" }
    );
  });

  test("defaults to the recommended model", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderGallery({ onSelect });
    await openBlueprint(user);

    await user.click(screen.getByRole("button", { name: "Install Blueprint" }));
    expect(onSelect).toHaveBeenCalledWith(expect.anything(), { model: "llama3.2:3b" });
  });

  test("opting out of a first model passes null, and says nothing will work yet", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderGallery({ onSelect });
    await openBlueprint(user);

    await user.selectOptions(screen.getByLabelText("Model to download after install"), "");
    expect(screen.getByText(/nothing will work until at least one model is installed/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Install Blueprint" }));
    expect(onSelect).toHaveBeenCalledWith(expect.anything(), { model: null });
  });

  test("an ordinary template still installs with no model choice", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderGallery({ onSelect });

    // Anchored on the card's own description — "PostgreSQL" alone also
    // matches the Immich PostgreSQL card.
    const postgresCard = screen
      .getByText("The popular open-source relational database.")
      .closest("button") as HTMLElement;
    await user.click(postgresCard);
    expect(screen.queryByLabelText("Model to download after install")).not.toBeInTheDocument();
    expect(screen.queryByText("Server requirements")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Install PostgreSQL" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "postgres" }), {
      model: null
    });
  });
});
