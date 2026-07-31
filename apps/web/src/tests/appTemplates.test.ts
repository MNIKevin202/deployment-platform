import { describe, expect, test } from "vitest";
import { APP_TEMPLATES, generateSecret, templatesInCategory } from "../lib/appTemplates";

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

  test("templatesInCategory returns entries sorted A–Z, case-insensitively", () => {
    for (const category of ["Databases", "Apps", "Tools"] as const) {
      const names = templatesInCategory(category).map((t) => t.name);
      const sorted = [...names].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );
      expect(names).toEqual(sorted);
      expect(names.length).toBeGreaterThan(0);
    }
  });

  test("template ids are unique", () => {
    const ids = APP_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("published ports (when present) are well-formed", () => {
    for (const template of APP_TEMPLATES) {
      for (const port of template.publishedPorts ?? []) {
        expect(port.hostPort).toBeGreaterThanOrEqual(1);
        expect(port.hostPort).toBeLessThanOrEqual(65535);
        expect(port.containerPort).toBeGreaterThanOrEqual(1);
        expect(port.containerPort).toBeLessThanOrEqual(65535);
        expect(["tcp", "udp"]).toContain(port.protocol);
      }
    }
  });

  test("the Minecraft templates publish a host port and skip a public domain", () => {
    const minecraft = APP_TEMPLATES.filter((t) => t.id.startsWith("minecraft"));
    expect(minecraft.length).toBeGreaterThanOrEqual(2);
    for (const template of minecraft) {
      expect(template.internalOnly).toBe(true);
      expect(template.publishedPorts?.length).toBeGreaterThan(0);
    }
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
