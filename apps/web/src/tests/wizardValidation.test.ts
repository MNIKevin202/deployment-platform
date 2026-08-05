import { describe, expect, test } from "vitest";
import { isValidAppName, isValidContainerPath, sanitizeAppName } from "../lib/wizardValidation";

describe("sanitizeAppName", () => {
  test.each([
    ["ClovaChatWebsite", "clovachatwebsite"],
    ["My App", "my-app"],
    ["my_service_name", "my-service-name"],
    ["Hello  World!!", "hello-world"],
    ["Café Site", "caf-site"],
    ["already-valid-9", "already-valid-9"],
    ["  Spaced Out  ", "-spaced-out-"]
  ])("%s -> %s", (input, expected) => {
    expect(sanitizeAppName(input)).toBe(expected);
  });

  test("caps length at 40 characters", () => {
    expect(sanitizeAppName("a".repeat(60))).toHaveLength(40);
  });

  test("output of a reasonable name passes isValidAppName", () => {
    expect(isValidAppName(sanitizeAppName("ClovaChatWebsite"))).toBe(true);
  });
});

describe("isValidContainerPath — reserved paths and the template allowance", () => {
  test("accepts ordinary application paths", () => {
    expect(isValidContainerPath("/data")).toBe(true);
    expect(isValidContainerPath("/var/lib/myapp")).toBe(true);
  });

  test("rejects reserved system trees for hand-entered paths", () => {
    expect(isValidContainerPath("/etc")).toBe(false);
    expect(isValidContainerPath("/usr/local")).toBe(false);
    expect(isValidContainerPath("/root")).toBe(false);
  });

  test("a curated template may use /root, which holds an image's own state", () => {
    expect(isValidContainerPath("/root", { allowReserved: true })).toBe(true);
    expect(isValidContainerPath("/root/.config", { allowReserved: true })).toBe(true);
  });

  test("even a curated template may not mount a genuine system tree", () => {
    // The allowance is deliberately narrow — it is not "templates can do anything".
    expect(isValidContainerPath("/etc", { allowReserved: true })).toBe(false);
    expect(isValidContainerPath("/etc/linkding/data", { allowReserved: true })).toBe(false);
    expect(isValidContainerPath("/usr", { allowReserved: true })).toBe(false);
    expect(isValidContainerPath("/proc", { allowReserved: true })).toBe(false);
  });

  test("the allowance never bypasses the structural path rules", () => {
    expect(isValidContainerPath("/root/../etc", { allowReserved: true })).toBe(false);
    expect(isValidContainerPath("relative/path", { allowReserved: true })).toBe(false);
  });
});
