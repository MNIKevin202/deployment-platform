import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryPanel from "../components/HistoryPanel";
import type { Deployment } from "../types/api";

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 1,
    appId: 5,
    version: 1,
    imageTag: "deployment-app-5:aaaaaaaaaaaa",
    commitSha: "aaaaaaaaaaaa1111",
    commitMessage: "first",
    sourceKind: "github",
    revertOfVersion: null,
    isCurrent: false,
    canRevert: true,
    createdAt: "2026-07-27T03:00:00.000Z",
    durationMs: null,
    ...overrides
  };
}

const githubHistory: Deployment[] = [
  deployment({ id: 2, version: 2, imageTag: "deployment-app-5:bbbbbbbbbbbb", isCurrent: true, canRevert: false, durationMs: 92_000 }),
  deployment({ id: 1, version: 1, imageTag: "deployment-app-5:aaaaaaaaaaaa", isCurrent: false, canRevert: true })
];

function mockFetchOnceSequence(handlers: Array<(url: string, init?: RequestInit) => unknown>) {
  let call = 0;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const handler = handlers[Math.min(call, handlers.length - 1)];
    call += 1;
    const body = handler(url, init);
    return { ok: true, json: async () => body } as Response;
  });
}

describe("HistoryPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders versions with the current one marked live and older ones revertable", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnceSequence([() => ({ success: true, deployments: githubHistory })])
    );

    render(<HistoryPanel appId={5} />);

    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    // The current version reads "Live".
    expect(screen.getByText(/Live/)).toBeInTheDocument();
    expect(screen.getByText("1m 32s")).toBeInTheDocument();
    // Exactly one revert control (only the older, non-current github version).
    expect(screen.getAllByRole("button", { name: /Revert to version 1/ })).toHaveLength(1);
  });

  test("reverting posts to the version endpoint and reloads", async () => {
    const revertedHistory: Deployment[] = [
      deployment({ id: 3, version: 3, imageTag: "deployment-app-5:aaaaaaaaaaaa", isCurrent: true, canRevert: false, revertOfVersion: 1 }),
      deployment({ id: 2, version: 2, imageTag: "deployment-app-5:bbbbbbbbbbbb", isCurrent: false, canRevert: true }),
      deployment({ id: 1, version: 1, imageTag: "deployment-app-5:aaaaaaaaaaaa", isCurrent: false, canRevert: true })
    ];

    const fetchMock = mockFetchOnceSequence([
      () => ({ success: true, deployments: githubHistory }), // initial load
      () => ({ success: true, message: "Reverted to version 1. This is now version 3.", newVersion: 3 }), // POST revert
      () => ({ success: true, deployments: revertedHistory }) // reload
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const onReverted = vi.fn();
    render(<HistoryPanel appId={5} onReverted={onReverted} />);

    const revertButton = await screen.findByRole("button", { name: /Revert to version 1/ });
    await userEvent.click(revertButton);

    // Confirmation dialog appears; confirm it.
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revert" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/apps/5/deployments/1/revert",
        expect.objectContaining({ method: "POST" })
      );
    });

    expect(onReverted).toHaveBeenCalled();
    expect(await screen.findByText(/revert of v1/)).toBeInTheDocument();
  });

  test("a non-github current-only history shows no revert controls", async () => {
    const dbHistory: Deployment[] = [
      deployment({
        id: 1,
        version: 1,
        imageTag: "postgres:16-alpine",
        commitSha: null,
        commitMessage: null,
        sourceKind: "image",
        isCurrent: true,
        canRevert: false
      })
    ];
    vi.stubGlobal("fetch", mockFetchOnceSequence([() => ({ success: true, deployments: dbHistory })]));

    render(<HistoryPanel appId={9} />);

    expect(await screen.findByText("v1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revert to version/ })).not.toBeInTheDocument();
  });
});
