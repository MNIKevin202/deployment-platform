import { describe, expect, test } from "vitest";
import { isValidAppName, sanitizeAppName } from "../lib/wizardValidation";

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
