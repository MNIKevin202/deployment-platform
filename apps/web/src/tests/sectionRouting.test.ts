import { describe, expect, test } from "vitest";
import { NAV_ITEMS, SECTIONS, parseSection } from "../layout/Sidebar";

describe("parseSection — ?section= deep links", () => {
  test("every section in the sidebar is deep-linkable", () => {
    // This is the actual regression guard: the old inline whitelist in
    // App.tsx was hand-maintained and silently omitted newer pages (cron,
    // templates), so linking to them dropped the user on Overview.
    for (const item of NAV_ITEMS) {
      expect(parseSection(item.key), `${item.key} should be deep-linkable`).toBe(item.key);
    }
  });

  test("templates and cron specifically resolve (the two that were missing)", () => {
    expect(parseSection("templates")).toBe("templates");
    expect(parseSection("cron")).toBe("cron");
  });

  test("an unknown or absent section is rejected so the caller can fall back", () => {
    expect(parseSection("not-a-section")).toBeNull();
    expect(parseSection(null)).toBeNull();
    expect(parseSection("")).toBeNull();
  });

  test("SECTIONS stays in sync with the nav", () => {
    expect([...SECTIONS]).toEqual(NAV_ITEMS.map((item) => item.key));
  });
});
