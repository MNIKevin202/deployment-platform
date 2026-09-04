import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import BuildLogPanel from "../components/BuildLogPanel";
import type { BuildLog } from "../types/api";

function stubFetch(buildLog: Partial<BuildLog> | null) {
  const full: BuildLog | null =
    buildLog === null
      ? null
      : { commitSha: null, autoDeployBlocked: false, truncated: false, status: null, at: null, log: null, ...buildLog };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ success: true, buildLog: full }) }) as Response)
  );
}

describe("BuildLogPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("shows the build output and a success status", async () => {
    stubFetch({
      log: "Step 1/2 : FROM node:24\nStep 2/2 : CMD npm start\nSuccessfully built abc123",
      truncated: false,
      status: "success",
      at: "2026-07-30T12:00:00.000Z"
    });

    render(<BuildLogPanel appId={5} appName="web" />);

    expect(await screen.findByText(/Successfully built abc123/)).toBeInTheDocument();
    expect(screen.getByText("Build succeeded")).toBeInTheDocument();
  });

  test("shows a failed status with the failing output", async () => {
    stubFetch({
      log: "npm ERR! missing script: build",
      truncated: false,
      status: "failed",
      at: "2026-07-30T12:00:00.000Z"
    });

    render(<BuildLogPanel appId={5} appName="web" />);

    expect(await screen.findByText(/npm ERR! missing script/)).toBeInTheDocument();
    expect(screen.getByText("Build failed")).toBeInTheDocument();
  });

  test("explains that a prebuilt-image app has no build logs", async () => {
    stubFetch(null);

    render(<BuildLogPanel appId={9} appName="db" />);

    expect(await screen.findByText(/runs a prebuilt image/)).toBeInTheDocument();
  });

  test("prompts to deploy when a source exists but nothing has been built", async () => {
    stubFetch({ log: null, truncated: false, status: null, at: null });

    render(<BuildLogPanel appId={5} appName="web" />);

    expect(await screen.findByText(/No build has run yet/)).toBeInTheDocument();
  });
});
