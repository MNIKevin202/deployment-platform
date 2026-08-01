import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InstallProgressModal from "../components/InstallProgressModal";
import type { InstallProgress } from "../types/api";

function progress(overrides: Partial<InstallProgress> = {}): InstallProgress {
  return {
    installId: "abc",
    status: "running",
    percent: 35,
    currentService: "blueprint-ollama",
    services: [
      {
        name: "blueprint-ollama",
        stage: "pulling",
        percent: 70,
        detail: "Downloading image (700 MB of 1.0 GB)"
      },
      { name: "blueprint", stage: "queued", percent: 0, detail: "Waiting to start…" }
    ],
    error: null,
    startedAt: "2026-08-01T00:00:00Z",
    finishedAt: null,
    ...overrides
  };
}

describe("InstallProgressModal", () => {
  test("renders nothing when closed", () => {
    const { container } = render(
      <InstallProgressModal
        open={false}
        appName="blueprint"
        progress={progress()}
        error=""
        onClose={() => {}}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("shows the percentage as an accessible progressbar", () => {
    render(
      <InstallProgressModal
        open
        appName="blueprint"
        progress={progress()}
        error=""
        onClose={() => {}}
      />
    );

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "35");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getByText("35%")).toBeInTheDocument();
  });

  test("sits honestly at 0% before the server has reported anything", () => {
    render(
      <InstallProgressModal
        open
        appName="blueprint"
        progress={null}
        error=""
        onClose={() => {}}
      />
    );

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  test("shows the real download detail from the current service", () => {
    render(
      <InstallProgressModal
        open
        appName="blueprint"
        progress={progress()}
        error=""
        onClose={() => {}}
      />
    );

    expect(screen.getAllByText(/700 MB of 1.0 GB/).length).toBeGreaterThan(0);
  });

  test("lists each service with its own bar for a multi-service install", () => {
    render(
      <InstallProgressModal
        open
        appName="blueprint"
        progress={progress()}
        error=""
        onClose={() => {}}
      />
    );

    expect(screen.getByText("blueprint-ollama")).toBeInTheDocument();
    expect(screen.getByText("blueprint")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  test("omits the per-service list for a single-app install", () => {
    render(
      <InstallProgressModal
        open
        appName="postgres"
        progress={progress({
          currentService: "postgres",
          services: [
            { name: "postgres", stage: "pulling", percent: 40, detail: "Downloading image" }
          ]
        })}
        error=""
        onClose={() => {}}
      />
    );

    expect(document.querySelector(".install-progress-services")).toBeNull();
    expect(screen.getByText(/Installing postgres/)).toBeInTheDocument();
  });

  test("cannot be dismissed while the install is still running", () => {
    render(
      <InstallProgressModal
        open
        appName="blueprint"
        progress={progress()}
        error=""
        onClose={() => {}}
      />
    );

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  test("reports completion and allows closing", async () => {
    const onClose = vi.fn();
    render(
      <InstallProgressModal
        open
        appName="blueprint"
        progress={progress({ status: "succeeded", percent: 100, currentService: null })}
        error=""
        onClose={onClose}
      />
    );

    expect(screen.getByText("Installation complete")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("shows the failure reason and never claims 100% on failure", () => {
    render(
      <InstallProgressModal
        open
        appName="blueprint"
        progress={progress({
          status: "failed",
          percent: 42,
          error: 'Unable to create the "blueprint-ollama" service: image pull failed'
        })}
        error=""
        onClose={() => {}}
      />
    );

    expect(screen.getByText("Installation failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("image pull failed");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  });

  test("falls back to the request error when the stream reported none", () => {
    render(
      <InstallProgressModal
        open
        appName="blueprint"
        progress={null}
        error="An app named &quot;blueprint&quot; already exists"
        onClose={() => {}}
      />
    );

    expect(screen.getByText("Installation failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
