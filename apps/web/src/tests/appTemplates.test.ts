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
    for (const category of ["Graphics", "Databases", "Apps", "Tools"] as const) {
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

describe("CanvasMint", () => {
  const template = APP_TEMPLATES.find((entry) => entry.id === "canvasmint");

  test("is in the catalog under Graphics as a first-party template", () => {
    expect(template).toBeDefined();
    expect(template!.category).toBe("Graphics");
    expect(template!.badge).toBe("DevMinted Original");
    expect(template!.iconImage).toBe("/canvasmint-icon.png");
  });

  test("publishes one HTTP port and takes a public domain", () => {
    expect(template!.containerPort).toBe(3000);
    // No publishedPorts and not internalOnly: it is reached over the
    // platform's HTTPS routing like any other web app.
    expect(template!.publishedPorts).toBeUndefined();
    expect(template!.internalOnly).toBeUndefined();
  });

  test("persists its data on /app/data", () => {
    expect(template!.volumes).toEqual(["/app/data"]);
  });

  /**
   * The app hashes whatever password it is given at boot, so a shared literal
   * baked into the catalog would be a shared credential across every install.
   * The session secret must be generated per-install and marked secret.
   */
  test("generates the session secret per install and marks it secret", () => {
    const secret = template!.env.find((entry) => entry.key === "SESSION_SECRET")!;
    expect(secret.generate).toBe("password");
    expect(secret.secret).toBe(true);
    expect(secret.value).toBeUndefined();
    expect(secret.generateLength).toBeGreaterThanOrEqual(32);
  });

  /**
   * CanvasMint treats a half-filled credential pair as "not configured" and
   * opens single-user. Shipping a generated password with a blank username
   * would therefore be worse than useless — it would look like auth was on
   * while the app stayed open — so both are deliberately blank literals.
   */
  test("leaves both admin fields blank so the default install is single-user", () => {
    const username = template!.env.find((entry) => entry.key === "ADMIN_USERNAME")!;
    const password = template!.env.find((entry) => entry.key === "ADMIN_PASSWORD")!;

    expect(username.value).toBe("");
    expect(username.generate).toBeUndefined();
    expect(password.value).toBe("");
    expect(password.generate).toBeUndefined();
    expect(password.secret).toBe(true);
  });

  test("exposes the upload and autosave settings the install form asks for", () => {
    const keys = template!.env.map((entry) => entry.key);
    expect(keys).toContain("APP_NAME");
    expect(keys).toContain("MAX_UPLOAD_MB");
    expect(keys).toContain("AUTOSAVE_DELAY_MS");
  });

  test("declares the resource guidance shown before install", () => {
    expect(template!.resources).toMatchObject({
      minCpu: 1,
      minMemoryMb: 512,
      minDiskGb: 5
    });
    expect(template!.resources!.recommendedMemoryMb).toBeGreaterThanOrEqual(1024);
    expect(template!.resources!.recommendedDiskGb).toBeGreaterThanOrEqual(5);
  });

  test("says where projects are stored, since that is what the volume holds", () => {
    const prose = [template!.longDescription, ...template!.highlights].join(" ").toLowerCase();
    expect(prose).toMatch(/persist|volume/);
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

describe("templates that seed an admin account on first boot", () => {
  /*
   * These images write their admin user into a persistent volume the first
   * time they boot and ignore the variables afterwards. If the template
   * doesn't ship the credentials, the first boot seeds someone else's
   * defaults and the operator can never set their own without wiping the
   * volume — which is exactly what happened with speedtest-tracker in
   * production before this was added.
   */
  const FIRST_BOOT_ADMIN_SEEDERS = ["speedtest-tracker"];

  test.each(FIRST_BOOT_ADMIN_SEEDERS)(
    "%s ships admin credentials so the first boot seeds the operator's own",
    (id) => {
      const template = APP_TEMPLATES.find((entry) => entry.id === id);
      expect(template, `${id} is missing from the catalog`).toBeDefined();

      const keys = template!.env.map((entry) => entry.key);
      expect(keys).toContain("ADMIN_EMAIL");
      expect(keys).toContain("ADMIN_PASSWORD");

      // The password must be generated per-install and marked secret, never a
      // shared literal baked into the catalog.
      const password = template!.env.find((entry) => entry.key === "ADMIN_PASSWORD")!;
      expect(password.generate).toBe("password");
      expect(password.secret).toBe(true);
      expect(password.value).toBeUndefined();
    }
  );

  test("such a template says the credentials only apply on the first boot", () => {
    for (const id of FIRST_BOOT_ADMIN_SEEDERS) {
      const template = APP_TEMPLATES.find((entry) => entry.id === id)!;
      const prose = [template.longDescription, ...template.highlights].join(" ").toLowerCase();
      expect(prose, `${id} should warn that seeding is first-boot only`).toMatch(/first boot/);
    }
  });
});
