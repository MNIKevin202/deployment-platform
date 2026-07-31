import { describe, expect, test } from "vitest";
import { APP_TEMPLATES, generateSecret } from "../lib/appTemplates";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

describe("APP_TEMPLATES catalog", () => {
  test("is non-empty and each entry is well-formed", () => {
    expect(APP_TEMPLATES.length).toBeGreaterThan(0);
    for (const template of APP_TEMPLATES) {
      expect(template.id).toBeTruthy();
      expect(template.name).toBeTruthy();
      expect(template.image).toMatch(/.+:.+|.+\/.+/);
      expect(template.containerPort).toBeGreaterThan(0);
      expect(template.suggestedName).toMatch(SLUG);
      expect(template.longDescription.length).toBeGreaterThan(30);
      expect(template.highlights.length).toBeGreaterThan(0);
      for (const highlight of template.highlights) {
        expect(highlight).toBeTruthy();
      }
      for (const env of template.env) {
        expect(env.key).toMatch(ENV_KEY);
      }
    }
  });

  test("template ids are unique", () => {
    const ids = APP_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("at least one template generates a secret (e.g. a DB password)", () => {
    const hasGenerated = APP_TEMPLATES.some((t) => t.env.some((e) => e.generate === "password"));
    expect(hasGenerated).toBe(true);
  });
});

describe("generateSecret", () => {
  test("returns the requested length from a safe alphabet", () => {
    const secret = generateSecret(24);
    expect(secret).toHaveLength(24);
    expect(secret).toMatch(/^[A-Za-z0-9]+$/);
  });

  test("is different each time", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});
