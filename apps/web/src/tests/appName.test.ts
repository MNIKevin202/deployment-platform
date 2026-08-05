import { describe, expect, test } from "vitest";
import { displayAppName, stripContainerPrefix } from "../lib/appName";

describe("stripContainerPrefix", () => {
  test("strips a leading slash and the app- prefix", () => {
    expect(stripContainerPrefix("/app-web")).toBe("web");
    expect(stripContainerPrefix("app-web")).toBe("web");
  });

  test("leaves an unprefixed container name alone", () => {
    expect(stripContainerPrefix("/some-container")).toBe("some-container");
  });
});

describe("displayAppName", () => {
  test("prefers the app's canonical name", () => {
    expect(displayAppName("web", "app-web")).toBe("web");
  });

  test("never mangles an app genuinely named with an app- prefix", () => {
    // The canonical name is authoritative — only container-derived names are stripped.
    expect(displayAppName("app-store", "app-app-store")).toBe("app-store");
  });

  test("falls back to the de-prefixed container name when there is no app record", () => {
    expect(displayAppName(null, "/app-orphan")).toBe("orphan");
    expect(displayAppName(undefined, "/app-orphan")).toBe("orphan");
  });

  test("falls back to the supplied fallback when there is neither", () => {
    expect(displayAppName(null, null, "abc123")).toBe("abc123");
    expect(displayAppName(null, undefined)).toBe("");
  });
});
