import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import UpdateBanner from "../components/UpdateBanner";

function setRunningBundle(name: string) {
  document.head.innerHTML = "";
  const script = document.createElement("script");
  script.src = `https://panel.example.com/assets/${name}`;
  document.head.appendChild(script);
}

function stubServedBundle(name: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => `<script type="module" src="/assets/${name}"></script>` }) as Response)
  );
}

describe("UpdateBanner", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setRunningBundle("index-RUNNING.js");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
  });

  test("shows when a newer bundle is served, and dismisses", async () => {
    stubServedBundle("index-NEWER.js");
    render(<UpdateBanner />);

    expect(await screen.findByText(/new version of the panel is available/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => {
      expect(screen.queryByText(/new version of the panel is available/i)).not.toBeInTheDocument();
    });
  });

  test("stays hidden when the served bundle matches", async () => {
    stubServedBundle("index-RUNNING.js");
    render(<UpdateBanner />);

    // Give the mount check a chance to run, then confirm nothing appeared.
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/new version of the panel is available/i)).not.toBeInTheDocument();
  });
});
