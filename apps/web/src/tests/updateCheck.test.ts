import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { basename, checkForUpdate, extractEntryBundle } from "../lib/updateCheck";

describe("updateCheck helpers", () => {
  test("basename strips path and query", () => {
    expect(basename("/assets/index-ABC123.js")).toBe("index-ABC123.js");
    expect(basename("https://x/assets/index-ABC.js?_=1")).toBe("index-ABC.js");
  });

  test("extractEntryBundle finds the module entry script", () => {
    const html = `<!doctype html><script type="module" crossorigin src="/assets/index-XYZ.js"></script>`;
    expect(extractEntryBundle(html)).toBe("index-XYZ.js");
  });

  test("extractEntryBundle falls back to an assets script", () => {
    const html = `<script defer src="/assets/main-999.js"></script>`;
    expect(extractEntryBundle(html)).toBe("main-999.js");
  });

  test("extractEntryBundle returns null when no bundle is referenced", () => {
    expect(extractEntryBundle("<html><body>no scripts</body></html>")).toBeNull();
  });
});

describe("checkForUpdate", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    const script = document.createElement("script");
    script.src = "https://panel.example.com/assets/index-RUNNING.js";
    document.head.appendChild(script);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
  });

  test("reports an update when the served bundle differs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => `<script type="module" src="/assets/index-SERVED.js"></script>`
    }) as Response));

    const status = await checkForUpdate();
    expect(status.running).toBe("index-RUNNING.js");
    expect(status.served).toBe("index-SERVED.js");
    expect(status.updateAvailable).toBe(true);
  });

  test("reports no update when the served bundle matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => `<script type="module" src="/assets/index-RUNNING.js"></script>`
    }) as Response));

    const status = await checkForUpdate();
    expect(status.updateAvailable).toBe(false);
  });
});
