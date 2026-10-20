import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import EnvValueCell from "../components/EnvValueCell";

describe("EnvValueCell secret reveal", () => {
  test("a withheld flagged secret fetches its plaintext on Show", async () => {
    const onReveal = vi.fn().mockResolvedValue("super-secret-value");
    render(<EnvValueCell keyName="API_KEY" value={null} hasValue isSecret onReveal={onReveal} />);

    // Masked until shown; the real value is not in the DOM.
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(screen.queryByText("super-secret-value")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => screen.getByText("super-secret-value"));
    expect(onReveal).toHaveBeenCalledTimes(1);
    // Can be hidden again.
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("super-secret-value")).toBeNull();
  });

  test("a withheld secret with NO onReveal offers no Show button", () => {
    render(<EnvValueCell keyName="API_KEY" value={null} hasValue isSecret />);
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
  });

  test("a failed reveal shows an error and does not expose a value", async () => {
    const onReveal = vi.fn().mockRejectedValue(new Error("nope"));
    render(<EnvValueCell keyName="API_KEY" value={null} hasValue isSecret onReveal={onReveal} />);
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => screen.getByText("Could not reveal"));
    expect(screen.getByText("••••••••")).toBeInTheDocument();
  });

  test("a non-secret value is shown directly (no reveal needed)", () => {
    render(<EnvValueCell keyName="PLAIN" value="hello world" hasValue isSecret={false} />);
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });
});
