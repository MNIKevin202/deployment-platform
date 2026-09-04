import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import UpdatesSettings from "../components/UpdatesSettings";

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
});

test("describes the browser-to-server check without claiming the server is current with GitHub", async () => {
  const script = document.createElement("script");
  script.src = "https://panel.example.com/assets/index-RUNNING.js";
  document.head.appendChild(script);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    text: async () => '<script type="module" src="/assets/index-RUNNING.js"></script>'
  }) as Response));

  render(<UpdatesSettings />);

  expect(await screen.findByText("This tab matches the version installed on this server.")).toBeInTheDocument();
  expect(screen.queryByText("You're running the latest version.")).not.toBeInTheDocument();
  expect(screen.getByText(/Server updates run separately in the background/)).toBeInTheDocument();
  // The deployed version and commit are shown (baked in at build time;
  // stubbed under vitest) so an operator can compare installs.
  expect(screen.getByText("0.0.0-test", { selector: "code" })).toBeInTheDocument();
  expect(screen.getByText("abc123def456", { selector: "code" })).toBeInTheDocument();
});
