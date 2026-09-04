import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DeploymentProgressOverlay, {
  formatDuration
} from "../components/DeploymentProgressOverlay";
import type { DeployProgress } from "../types/api";

function deployment(overrides: Partial<DeployProgress> = {}): DeployProgress {
  return {
    appId: 34,
    appName: "staxxio",
    source: "MNIKevin202/Staxxio@main",
    status: "running",
    stage: "building-image",
    stageLabel: "Building image",
    percent: 46,
    step: 6,
    totalSteps: 14,
    detail: "Building image",
    startedAt: "2026-08-01T11:11:44.000Z",
    finishedAt: null,
    etaSeconds: 95,
    error: null,
    failedStage: null,
    rolledBack: false,
    ...overrides
  };
}

interface Harness {
  emitSnapshot: (deployments: DeployProgress[]) => void;
  emitProgress: (progress: DeployProgress) => void;
  closed: number;
  urls: string[];
  deletes: string[];
}

function installEventSource(): Harness {
  const harness: Harness = {
    emitSnapshot: () => {},
    emitProgress: () => {},
    closed: 0,
    urls: [],
    deletes: []
  };

  class FakeEventSource {
    private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

    constructor(url: string) {
      harness.urls.push(url);
      const fire = (type: string, payload: unknown) => {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ data: JSON.stringify(payload) } as MessageEvent);
        }
      };
      harness.emitSnapshot = (deployments) => fire("snapshot", { deployments });
      harness.emitProgress = (progress) => fire("progress", progress);
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const existing = this.listeners.get(type) ?? [];
      existing.push(listener);
      this.listeners.set(type, existing);
    }

    close() {
      harness.closed += 1;
    }
  }

  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        harness.deletes.push(typeof input === "string" ? input : input.toString());
      }
      return new Response("{}", { status: 200 });
    })
  );

  return harness;
}

describe("DeploymentProgressOverlay", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("renders nothing when no deployment is running", () => {
    installEventSource();
    const { container } = render(<DeploymentProgressOverlay onViewApp={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("subscribes to the site-wide stream, not a per-app one", () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);
    expect(harness.urls).toEqual(["/api/deployments/progress"]);
  });

  test("shows anything already in flight from the initial snapshot", async () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);

    harness.emitSnapshot([deployment()]);

    expect(await screen.findByText("staxxio")).toBeInTheDocument();
    expect(screen.getByText("MNIKevin202/Staxxio@main")).toBeInTheDocument();
  });

  test("shows percent, stage, step counter, and time remaining", async () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);
    harness.emitSnapshot([deployment()]);

    expect(await screen.findByText("46%")).toBeInTheDocument();
    expect(screen.getByText("Building image")).toBeInTheDocument();
    expect(screen.getByText("Step 6/14")).toBeInTheDocument();
    expect(screen.getByText("~1m 35s remaining")).toBeInTheDocument();

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "46");
  });

  test("says it is estimating rather than inventing a countdown", async () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);
    harness.emitSnapshot([deployment({ etaSeconds: null })]);

    expect(await screen.findByText("Estimating…")).toBeInTheDocument();
  });

  test("live progress events update the existing card in place", async () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);
    harness.emitSnapshot([deployment({ percent: 46 })]);
    await screen.findByText("46%");

    harness.emitProgress(deployment({ percent: 72, step: 11 }));

    expect(await screen.findByText("72%")).toBeInTheDocument();
    expect(screen.queryByText("46%")).not.toBeInTheDocument();
    // Still one card — updated, not duplicated.
    expect(screen.getAllByText("staxxio")).toHaveLength(1);
  });

  test("tracks several concurrent deployments separately", async () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);

    harness.emitSnapshot([
      deployment({ appId: 1, appName: "one" }),
      deployment({ appId: 2, appName: "two" })
    ]);

    expect(await screen.findByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
  });

  test("a running deployment cannot be dismissed", async () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);
    harness.emitSnapshot([deployment()]);
    await screen.findByText("staxxio");

    expect(screen.queryByRole("button", { name: /Dismiss/ })).not.toBeInTheDocument();
  });

  test("a failure shows the reason and stays until dismissed", async () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);

    harness.emitSnapshot([
      deployment({
        status: "failed",
        percent: 46,
        etaSeconds: null,
        failedStage: "building-image",
        error:
          "Build failed: The command '/bin/sh -c npm run build' returned a non-zero code: 1"
      })
    ]);

    expect(await screen.findByText(/npm run build/)).toBeInTheDocument();
    expect(screen.getByText("Failed at: Building image")).toBeInTheDocument();
    // A failed deployment must never render as complete.
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "46");

    await userEvent.click(screen.getByRole("button", { name: /Dismiss/ }));

    await waitFor(() => expect(screen.queryByText("staxxio")).not.toBeInTheDocument());
    expect(harness.deletes).toEqual(["/api/deployments/progress/34"]);
  });

  test("a rollback is called out on the failure card", async () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);
    harness.emitSnapshot([
      deployment({ status: "failed", error: "health check failed", rolledBack: true })
    ]);

    expect(await screen.findByText("The previous version was restored.")).toBeInTheDocument();
  });

  test("Open app navigates to the failed app", async () => {
    const harness = installEventSource();
    const onViewApp = vi.fn();
    render(<DeploymentProgressOverlay onViewApp={onViewApp} />);
    harness.emitSnapshot([deployment({ status: "failed", error: "boom" })]);

    await userEvent.click(await screen.findByRole("button", { name: "Open app" }));
    expect(onViewApp).toHaveBeenCalledWith(34);
  });

  test("a live failure auto-opens the build-failure modal; a snapshot failure does not", async () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);

    // A snapshot (e.g. on reconnect) must not resurface an old failure.
    harness.emitSnapshot([deployment({ status: "failed", error: "old boom" })]);
    expect(await screen.findByText("staxxio")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    // A live transition to failed pops the modal with the build output.
    harness.emitProgress(deployment({ status: "failed", error: "fresh boom" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/didn.t deploy/)).toBeInTheDocument();
  });

  test("a completed deployment reports 100% and can be dismissed", async () => {
    const harness = installEventSource();
    render(<DeploymentProgressOverlay onViewApp={() => {}} />);
    harness.emitSnapshot([
      deployment({
        status: "succeeded",
        percent: 100,
        stage: "deployment-complete",
        stageLabel: "Deployed",
        etaSeconds: null
      })
    ]);

    expect(await screen.findByText("100%")).toBeInTheDocument();
    expect(screen.getByText("Deployed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dismiss/ })).toBeInTheDocument();
  });

  test("closes the stream on unmount", () => {
    const harness = installEventSource();
    const { unmount } = render(<DeploymentProgressOverlay onViewApp={() => {}} />);
    unmount();
    expect(harness.closed).toBe(1);
  });

  test("a browser without EventSource renders nothing instead of crashing", () => {
    vi.stubGlobal("EventSource", undefined);
    expect(() =>
      render(<DeploymentProgressOverlay onViewApp={() => {}} />)
    ).not.toThrow();
  });
});

describe("formatDuration", () => {
  test("renders seconds and minutes compactly", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(95)).toBe("1m 35s");
    expect(formatDuration(120)).toBe("2m");
  });
});
