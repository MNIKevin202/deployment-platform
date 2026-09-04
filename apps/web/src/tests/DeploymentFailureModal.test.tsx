import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DeploymentFailureModal from "../components/DeploymentFailureModal";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function stub(buildLog: Record<string, unknown> | null): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body as string) : null
      });
      if (init?.method === "POST") {
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      return { ok: true, json: async () => ({ success: true, buildLog }) } as Response;
    })
  );
  return calls;
}

describe("DeploymentFailureModal", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("shows the build output and copies the full log", async () => {
    stub({
      log: "npm ERR! build failed on line 42",
      truncated: false,
      status: "failed",
      at: "2026-09-04T00:00:00.000Z",
      commitSha: "abc123def456",
      autoDeployBlocked: false
    });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(
      <DeploymentFailureModal appId={5} appName="web" reason="Build failed" rolledBack onClose={() => {}} />
    );

    expect(await screen.findByText(/build failed on line 42/)).toBeInTheDocument();
    expect(screen.getByText(/previous version is still running/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Copy log" }));
    expect(writeText).toHaveBeenCalledWith("npm ERR! build failed on line 42");
  });

  test("blocking the failed commit posts to the block-commit endpoint", async () => {
    const calls = stub({
      log: "boom",
      truncated: false,
      status: "failed",
      at: "2026-09-04T00:00:00.000Z",
      commitSha: "abc123def456",
      autoDeployBlocked: false
    });

    render(<DeploymentFailureModal appId={5} appName="web" reason="Build failed" rolledBack={false} onClose={() => {}} />);

    const checkbox = await screen.findByRole("checkbox", { name: /Stop auto-redeploying this commit/ });
    await userEvent.click(checkbox);

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect(post?.url).toBe("/api/apps/5/source/block-commit");
      expect(post?.body).toEqual({ commitSha: "abc123def456", blocked: true });
    });
  });

  test("offers no block control when the build did not fail", async () => {
    stub({
      log: "ok",
      truncated: false,
      status: "success",
      at: "2026-09-04T00:00:00.000Z",
      commitSha: "abc123def456",
      autoDeployBlocked: false
    });

    render(<DeploymentFailureModal appId={5} appName="web" reason={null} rolledBack={false} onClose={() => {}} />);

    await screen.findByText(/ok/);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
