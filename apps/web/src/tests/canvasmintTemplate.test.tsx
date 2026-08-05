import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateAppWizard, { postInstallNoticeForTemplate } from "../components/CreateAppWizard";
import TemplateGallery from "../components/TemplateGallery";
import { APP_TEMPLATES, generateSecret, templatesInCategory } from "../lib/appTemplates";
import { findInstalledTemplateApp } from "../lib/templateInstallStatus";

const canvasmint = APP_TEMPLATES.find((entry) => entry.id === "canvasmint")!;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/environment/global") return jsonResponse(200, { variables: [] });
      if (url === "/api/integrations/github") return jsonResponse(200, { connected: false });
      if (url === "/api/apps/wizard/brief") return jsonResponse(200, { domain: "x", brief: "b" });
      throw new Error(`Unhandled fetch in test: ${url}`);
    })
  );
}

describe("CanvasMint in the template gallery", () => {
  test("appears under a Graphics category chip", () => {
    render(
      <TemplateGallery onSelect={() => {}} storedApps={[]} onViewApp={() => {}} hostInfo={null} />
    );

    const chips = screen.getByRole("group", { name: "Template categories" });
    expect(within(chips).getByRole("button", { name: /^Graphics/ })).toBeInTheDocument();
    expect(screen.getByText("CanvasMint")).toBeInTheDocument();
  });

  test("Graphics contains CanvasMint", () => {
    expect(templatesInCategory("Graphics").map((entry) => entry.id)).toContain("canvasmint");
  });

  test("its detail view states the image, port, and volume before installing", async () => {
    const user = userEvent.setup();
    render(
      <TemplateGallery onSelect={() => {}} storedApps={[]} onViewApp={() => {}} hostInfo={null} />
    );

    await user.click(screen.getByText("CanvasMint"));

    expect(screen.getByText("ghcr.io/mnikevin202/canvasmint:latest")).toBeInTheDocument();
    expect(screen.getByText("3000")).toBeInTheDocument();
    expect(screen.getByText("/app/data")).toBeInTheDocument();
    // The generated secret is disclosed as auto-generated rather than shown.
    expect(screen.getByText("SESSION_SECRET")).toBeInTheDocument();
    expect(screen.getAllByText("auto-generated").length).toBeGreaterThan(0);
  });

  test("installing hands the template to the caller", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <TemplateGallery onSelect={onSelect} storedApps={[]} onViewApp={() => {}} hostInfo={null} />
    );

    await user.click(screen.getByText("CanvasMint"));
    await user.click(screen.getByRole("button", { name: "Install CanvasMint" }));

    expect(onSelect).toHaveBeenCalledWith(canvasmint, expect.anything());
  });
});

describe("CanvasMint installed-state detection", () => {
  test("an existing app on the same image is recognised, whatever its tag", () => {
    const match = findInstalledTemplateApp(canvasmint, [
      { id: 7, name: "my-editor", image: "ghcr.io/mnikevin202/canvasmint:1.0.0" }
    ]);
    expect(match).toEqual({ appId: 7, appName: "my-editor" });
  });

  test("an unrelated app is not mistaken for it", () => {
    expect(findInstalledTemplateApp(canvasmint, [{ id: 1, name: "x", image: "nginx:latest" }])).toBeNull();
  });

  test("the gallery shows an Installed badge once it is deployed", () => {
    render(
      <TemplateGallery
        onSelect={() => {}}
        storedApps={[{ id: 3, name: "canvasmint", image: "ghcr.io/mnikevin202/canvasmint:latest" }]}
        onViewApp={() => {}}
        hostInfo={null}
      />
    );

    const card = screen.getByText("CanvasMint").closest("button")!;
    expect(within(card).getByText("Installed")).toBeInTheDocument();
  });
});

describe("CanvasMint pre-fills the Create App wizard", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("seeds the Basics step with the app name and image", async () => {
    installFetchMock();
    render(
      <CreateAppWizard open initialTemplate={canvasmint} onClose={() => {}} onCreated={() => {}} />
    );

    const name = (await screen.findByLabelText("App name", { exact: false })) as HTMLInputElement;
    expect(name.value).toBe("canvasmint");

    const image = screen.getByLabelText("Docker image", { exact: false }) as HTMLInputElement;
    expect(image.value).toBe("ghcr.io/mnikevin202/canvasmint:latest");
  });

  /**
   * The session secret is the one value that must differ per install: a shared
   * one would let a cookie minted on one deployment authenticate against
   * another. The wizard fills it from generateSecret at seed time, so what
   * this pins is that the generator really does produce a distinct,
   * high-entropy value each time it is called.
   */
  test("the generated session secret is distinct and long enough each time", () => {
    const declared = canvasmint.env.find((entry) => entry.key === "SESSION_SECRET")!;
    const length = declared.generateLength ?? 24;

    const generated = new Set(Array.from({ length: 50 }, () => generateSecret(length)));
    expect(generated.size).toBe(50);

    for (const secret of generated) {
      expect(secret).toHaveLength(length);
      expect(secret).toMatch(/^[A-Za-z0-9]+$/);
    }
  });
});

describe("CanvasMint post-install notice", () => {
  const row = (key: string, value: string) => ({ key, value, enabled: true });

  test("always says where projects are stored", () => {
    const notice = postInstallNoticeForTemplate(canvasmint, []);
    expect(notice).toContain("/app/data");
    expect(notice).toMatch(/persistent volume/i);
    expect(notice).toMatch(/survive restarts/i);
  });

  test("names the configured admin user when a login was set up", () => {
    const notice = postInstallNoticeForTemplate(canvasmint, [
      row("ADMIN_USERNAME", "studio"),
      row("ADMIN_PASSWORD", "generated-secret")
    ]);

    expect(notice).toContain('Sign in as "studio"');
    // The password itself is never echoed into the notice — the platform's
    // own secret handling is what discloses it.
    expect(notice).not.toContain("generated-secret");
  });

  test("warns that a default install is open to anyone who can reach it", () => {
    const notice = postInstallNoticeForTemplate(canvasmint, [
      row("ADMIN_USERNAME", ""),
      row("ADMIN_PASSWORD", "")
    ]);

    expect(notice).toMatch(/single-user mode/i);
    expect(notice).toMatch(/anyone who can reach its domain/i);
  });

  /**
   * The trap this catches: an operator fills in only the username, assumes
   * they now have a login, and leaves an open editor on a public domain.
   */
  test.each([
    ["only a username", [row("ADMIN_USERNAME", "studio"), row("ADMIN_PASSWORD", "")]],
    ["only a password", [row("ADMIN_USERNAME", ""), row("ADMIN_PASSWORD", "secret")]],
    ["a whitespace username", [row("ADMIN_USERNAME", "   "), row("ADMIN_PASSWORD", "secret")]]
  ])("calls out a half-configured login (%s)", (_label, rows) => {
    const notice = postInstallNoticeForTemplate(canvasmint, rows);
    expect(notice).toMatch(/only one of/i);
    expect(notice).toMatch(/single-user mode/i);
  });

  test("ignores a disabled env row", () => {
    const notice = postInstallNoticeForTemplate(canvasmint, [
      { key: "ADMIN_USERNAME", value: "studio", enabled: false },
      { key: "ADMIN_PASSWORD", value: "secret", enabled: false }
    ]);
    expect(notice).toMatch(/single-user mode/i);
    expect(notice).not.toContain("studio");
  });

  test("says nothing for any other template", () => {
    const postgres = APP_TEMPLATES.find((entry) => entry.id === "postgres")!;
    expect(postInstallNoticeForTemplate(postgres, [])).toBe("");
    expect(postInstallNoticeForTemplate(null, [])).toBe("");
  });
});
