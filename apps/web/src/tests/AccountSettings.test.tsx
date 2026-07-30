import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AccountSettings from "../components/AccountSettings";

describe("AccountSettings", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  test("posts a password change and shows a success notice", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, message: "Password updated." })
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<AccountSettings />);

    await userEvent.type(screen.getByLabelText("Current password"), "oldpass1");
    await userEvent.type(screen.getByLabelText("New password"), "newpass12");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "newpass12");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/account/password",
        expect.objectContaining({ method: "POST" })
      );
    });
    expect(await screen.findByText("Password updated.")).toBeInTheDocument();
  });

  test("blocks submit when the confirmation doesn't match, without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<AccountSettings />);
    await userEvent.type(screen.getByLabelText("Current password"), "oldpass1");
    await userEvent.type(screen.getByLabelText("New password"), "newpass12");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "different9");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(await screen.findByText(/do not match/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
