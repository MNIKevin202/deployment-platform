import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConsolePanel from "../components/ConsolePanel";

type Listener = (event: MessageEvent) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: Listener) {
    (this.listeners[type] ||= []).push(cb);
  }

  close() {
    this.closed = true;
  }

  // --- test helpers ---
  open() {
    this.onopen?.();
  }

  emit(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) {
      cb({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

describe("ConsolePanel", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function latest() {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }

  test("opens a stream for the app and shows streamed lines", async () => {
    const { container } = render(<ConsolePanel appId={5} />);

    const source = latest();
    expect(source.url).toContain("/api/apps/5/logs/stream");
    expect(source.url).toContain("tail=200");

    act(() => source.open());
    expect(screen.getByText(/Live/)).toBeInTheDocument();

    act(() => {
      source.emit("line", { line: "hello world" });
      source.emit("line", { line: "second line" });
    });

    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("hello world");
    expect(pre?.textContent).toContain("second line");
    expect(screen.getByText("2 lines")).toBeInTheDocument();
    expect(screen.getByText(/Last output:/)).toBeInTheDocument();
  });

  test("marks the stream stopped and closes it on an end event", async () => {
    render(<ConsolePanel appId={7} />);
    const source = latest();

    act(() => source.open());
    act(() => source.emit("end", {}));

    expect(screen.getByText(/Stopped/)).toBeInTheDocument();
    expect(source.closed).toBe(true);
  });

  test("surfaces a server notice", async () => {
    render(<ConsolePanel appId={3} />);
    const source = latest();

    act(() => source.emit("notice", { message: "The container for this app does not exist." }));

    expect(screen.getByText(/does not exist/)).toBeInTheDocument();
  });

  test("Clear empties the console", async () => {
    const { container } = render(<ConsolePanel appId={5} />);
    const source = latest();

    act(() => source.open());
    act(() => source.emit("line", { line: "temporary" }));
    expect(container.querySelector("pre")?.textContent).toContain("temporary");

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.getByText("0 lines")).toBeInTheDocument();
  });

  test("copies the full retained console buffer", async () => {
    render(<ConsolePanel appId={5} />);
    const source = latest();

    act(() => {
      source.emit("line", { line: "first line" });
      source.emit("line", { line: "second line" });
    });

    await userEvent.click(screen.getByRole("button", { name: "Copy console" }));

    expect(writeText).toHaveBeenCalledWith("first line\nsecond line");
    expect(await screen.findByRole("button", { name: "Copied!" })).toBeInTheDocument();
  });
});
