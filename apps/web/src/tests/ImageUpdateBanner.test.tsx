import { afterEach, describe, expect, test } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ImageUpdateBanner from "../components/ImageUpdateBanner";

afterEach(() => {
  sessionStorage.clear();
  cleanup();
});

describe("ImageUpdateBanner", () => {
  test("renders nothing when no update is available", () => {
    render(<ImageUpdateBanner appId={1} imageUpdateAvailable={false} imageUpdateCheckedAt={null} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("shows the banner when an update is available", () => {
    render(
      <ImageUpdateBanner appId={1} imageUpdateAvailable={true} imageUpdateCheckedAt="2026-01-01T00:00:00.000Z" />
    );
    expect(screen.getByText(/A new image is available for this app/)).toBeInTheDocument();
  });

  test("dismissing hides the banner for that same check", async () => {
    const user = userEvent.setup();
    render(
      <ImageUpdateBanner appId={1} imageUpdateAvailable={true} imageUpdateCheckedAt="2026-01-01T00:00:00.000Z" />
    );

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("a later, newer check reappears despite an earlier dismissal", () => {
    sessionStorage.setItem("dp_dismissed_image_update_1", "2026-01-01T00:00:00.000Z");

    render(
      <ImageUpdateBanner appId={1} imageUpdateAvailable={true} imageUpdateCheckedAt="2026-01-02T00:00:00.000Z" />
    );

    expect(screen.getByText(/A new image is available for this app/)).toBeInTheDocument();
  });

  test("dismissal is scoped per app id", () => {
    sessionStorage.setItem("dp_dismissed_image_update_1", "2026-01-01T00:00:00.000Z");

    render(
      <ImageUpdateBanner appId={2} imageUpdateAvailable={true} imageUpdateCheckedAt="2026-01-01T00:00:00.000Z" />
    );

    expect(screen.getByText(/A new image is available for this app/)).toBeInTheDocument();
  });
});
