import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DeployProgressBanner,
  InlineDeployProgress
} from "../components/DeployProgressIndicator";
import type { DeployProgress } from "../types/api";

function progress(overrides: Partial<DeployProgress> = {}): DeployProgress {
  return {
    appId: 7,
    appName: "staxxio",
    source: "MNIKevin202/Staxxio@main",
    status: "running",
    stage: "building-image",
    stageLabel: "Building image",
    percent: 42,
    step: 7,
    totalSteps: 14,
    detail: "Building image",
    startedAt: "2026-08-01T00:00:00Z",
    finishedAt: null,
    etaSeconds: 90,
    error: null,
    failedStage: null,
    rolledBack: false,
    ...overrides
  };
}

describe("InlineDeployProgress", () => {
  test("shows the percentage, stage, and a progressbar at the measured value", () => {
    render(<InlineDeployProgress progress={progress()} />);

    expect(screen.getByText("Deploying")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("Building image")).toBeInTheDocument();

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
  });
});

describe("DeployProgressBanner", () => {
  test("shows the step counter and an ETA when estimable", () => {
    render(<DeployProgressBanner progress={progress()} />);

    expect(screen.getByText("Deploying…")).toBeInTheDocument();
    expect(screen.getByText("MNIKevin202/Staxxio@main")).toBeInTheDocument();
    expect(screen.getByText("Step 7/14")).toBeInTheDocument();
    expect(screen.getByText("~1m 30s remaining")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  });

  test("shows 'Estimating…' while the ETA is not yet meaningful", () => {
    render(<DeployProgressBanner progress={progress({ etaSeconds: null, step: null, totalSteps: null })} />);

    expect(screen.getByText("Estimating…")).toBeInTheDocument();
    expect(screen.queryByText(/Step /)).not.toBeInTheDocument();
  });
});
