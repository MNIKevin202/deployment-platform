import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ResourcesSection from "../components/ResourcesSection";

describe("ResourcesSection", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  test("pre-fills current limits and PATCHes the new values", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ success: true }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();

    render(
      <ResourcesSection appId={5} memoryLimitMb={256} cpuLimit={null} containerRunning onSaved={onSaved} />
    );

    const memory = screen.getByLabelText("Memory limit (MB)") as HTMLInputElement;
    expect(memory.value).toBe("256");

    await userEvent.clear(memory);
    await userEvent.type(memory, "512");
    await userEvent.click(screen.getByRole("button", { name: "Save & apply" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/apps/5/resources",
        expect.objectContaining({ method: "PATCH" })
      );
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ memoryLimitMb: 512, cpuLimit: null });
    expect(onSaved).toHaveBeenCalled();
    expect(await screen.findByText(/Resource limits applied/)).toBeInTheDocument();
  });
});
