import { describe, expect, test } from "vitest";
import { APP_TEMPLATES, generateSecret, templatesInCategory } from "../lib/appTemplates";
import { isValidContainerPath, isValidAppName, isValidImage } from "../lib/wizardValidation";

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

  /**
   * These guard the catalog against the SAME rules the API enforces on the
   * wizard payload. Without them a template can look perfectly reasonable
   * and still be rejected at install time with "Invalid app configuration"
   * — which is exactly what happened when Blueprint's model server was
   * pointed at /root/.ollama, a path the platform reserves.
   */
  /**
   * Templates that CANNOT currently be installed, because the image hard-codes
   * its data directory inside a tree the platform reserves and offers no way
   * to relocate it.
   *
   * This is an acknowledgement of a known defect, not an approval: each entry
   * here is a template whose install fails with "Invalid app configuration".
   * Resolving one means either relaxing the storage policy for that tree (a
   * deliberate security decision) or dropping the template — not quietly
   * adding more names to this list.
   *
   * - linkding: WORKDIR /etc/linkding + `mkdir data`, no LD_DATA_DIR-style
   *   override exists, so its data can only live under the reserved /etc.
   */
  const KNOWN_UNINSTALLABLE = new Set(["linkding"]);

  test("every template's storage paths are ones the platform will actually accept", () => {
    for (const template of APP_TEMPLATES) {
      if (KNOWN_UNINSTALLABLE.has(template.id)) {
        continue;
      }

      for (const path of template.volumes ?? []) {
        // Curated templates are the vetted case allowed to declare an
        // otherwise-reserved path their image genuinely requires (RustDesk
        // keeps its keypair in /root) — the wizard passes the same flag for
        // template-seeded rows. A hand-typed path never gets this.
        expect(
          isValidContainerPath(path, { allowReserved: true }),
          `${template.id}: "${path}" is not an acceptable container path`
        ).toBe(true);
      }
    }
  });

  test("the known-uninstallable list stays accurate — entries really are broken", () => {
    // If a template on the list starts passing, it was fixed and must be
    // removed from the list rather than left permanently exempt.
    for (const id of KNOWN_UNINSTALLABLE) {
      const template = APP_TEMPLATES.find((entry) => entry.id === id);
      expect(template, `${id} is listed but no longer in the catalog`).toBeDefined();
      expect(
        (template!.volumes ?? []).some(
          (path) => !isValidContainerPath(path, { allowReserved: true })
        ),
        `${id} now has only valid paths — remove it from KNOWN_UNINSTALLABLE`
      ).toBe(true);
    }
  });

  test("every companion's storage paths, name, and image are acceptable too", () => {
    for (const template of APP_TEMPLATES) {
      for (const companion of template.companions ?? []) {
        for (const path of companion.volumes ?? []) {
          expect(
            isValidContainerPath(path, { allowReserved: true }),
            `${template.id}/${companion.key}: "${path}" is not an acceptable container path`
          ).toBe(true);
        }

        // The companion's app name is derived from the operator's chosen
        // name plus this suffix, so both halves must stay valid.
        expect(
          isValidAppName(`${template.suggestedName}${companion.nameSuffix}`),
          `${template.id}/${companion.key}: derived app name is invalid`
        ).toBe(true);
        expect(isValidImage(companion.image)).toBe(true);

        for (const env of companion.env ?? []) {
          expect(env.key).toMatch(ENV_KEY);
        }
      }
    }
  });

  test("every template's own name and image would pass the wizard's checks", () => {
    for (const template of APP_TEMPLATES) {
      expect(isValidAppName(template.suggestedName), `${template.id}: bad name`).toBe(true);
      expect(isValidImage(template.image), `${template.id}: bad image`).toBe(true);
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
