import { describe, expect, test } from "vitest";
import { NAV_ITEMS, SECTIONS, parseSection, primaryOf } from "../layout/Sidebar";

describe("parseSection — ?section= deep links", () => {
  test("every sidebar area is deep-linkable", () => {
    for (const item of NAV_ITEMS) {
      expect(parseSection(item.key), `${item.key} should be deep-linkable`).toBe(item.key);
    }
  });

  test("legacy / sub-destination links still resolve after the IA consolidation", () => {
    // These used to be their own sidebar items; they now open inside a primary
    // area, but old bookmarks and the GitHub OAuth callback (?section=repositories)
    // must keep working.
    for (const legacy of [
      "databases",
      "connections",
      "templates",
      "repositories",
      "cron",
      "environment",
      "system",
      "settings"
    ]) {
      expect(parseSection(legacy), `${legacy} should still resolve`).toBe(legacy);
    }
  });

  test("an unknown or absent section is rejected so the caller can fall back", () => {
    expect(parseSection("not-a-section")).toBeNull();
    expect(parseSection(null)).toBeNull();
    expect(parseSection("")).toBeNull();
  });

  test("every sidebar area is a valid section", () => {
    for (const item of NAV_ITEMS) {
      expect(SECTIONS).toContain(item.key);
    }
  });

  test("every section maps to a sidebar area", () => {
    for (const section of SECTIONS) {
      expect(NAV_ITEMS.map((item) => item.key)).toContain(primaryOf(section));
    }
  });

  test("legacy sections map into the expected area", () => {
    expect(primaryOf("databases")).toBe("apps");
    expect(primaryOf("templates")).toBe("apps");
    expect(primaryOf("connections")).toBe("resources");
    expect(primaryOf("environment")).toBe("resources");
    expect(primaryOf("repositories")).toBe("resources");
    expect(primaryOf("cron")).toBe("automation");
    expect(primaryOf("system")).toBe("platform");
    expect(primaryOf("settings")).toBe("platform");
  });
});
