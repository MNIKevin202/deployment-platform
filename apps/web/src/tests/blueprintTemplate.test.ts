import { describe, expect, test } from "vitest";
import {
  APP_TEMPLATES,
  BLUEPRINT_MODEL_CHOICES,
  companionAppName,
  resolveTemplatePlaceholders,
  templatesInCategory
} from "../lib/appTemplates";
import { assessHostForTemplate, formatGb } from "../lib/templateResources";
import { isBlueprintImage } from "../lib/appKind";

const blueprint = APP_TEMPLATES.find((template) => template.id === "blueprint");

describe("Blueprint template", () => {
  test("appears in the AI category as a DevMinted Original", () => {
    expect(blueprint).toBeDefined();
    expect(blueprint!.category).toBe("AI");
    expect(blueprint!.badge).toBe("DevMinted Original");
    expect(blueprint!.description).toBe(
      "Private AI workspace powered by models running directly on your VPS."
    );
    expect(templatesInCategory("AI").map((t) => t.id)).toContain("blueprint");
  });

  test("uses a first-party icon rather than an external logo", () => {
    expect(blueprint!.iconImage).toBe("/blueprint-icon.png");
  });

  test("pins both images to explicit versions rather than a floating tag", () => {
    expect(blueprint!.image).toBe("ghcr.io/open-webui/open-webui:0.11.0");
    expect(blueprint!.image).not.toMatch(/:latest$/);

    const ollama = blueprint!.companions![0];
    expect(ollama.image).toBe("ollama/ollama:0.32.5");
    expect(ollama.image).not.toMatch(/:latest$/);
  });

  test("the chat interface is publicly routed on the port Open WebUI listens on", () => {
    // internalOnly unset means the wizard leaves routing on "public".
    expect(blueprint!.internalOnly).toBeUndefined();
    expect(blueprint!.containerPort).toBe(8080);
  });

  test("the model server is internal-only and publishes no host port", () => {
    const ollama = blueprint!.companions![0];
    expect(ollama.internalOnly).toBe(true);
    expect(ollama.containerPort).toBe(11434);
    // A companion has no publishedPorts field at all — there is no way for a
    // template to open a host port for a backing service.
    expect("publishedPorts" in ollama).toBe(false);
    expect(blueprint!.publishedPorts).toBeUndefined();
  });

  test("both services get their own persistent volume", () => {
    expect(blueprint!.volumes).toEqual(["/app/backend/data"]);
    expect(blueprint!.companions![0].volumes).toEqual(["/root/.ollama"]);
  });

  test("connects to the model server internally, never localhost or a public host", () => {
    const baseUrl = blueprint!.env.find((env) => env.key === "OLLAMA_BASE_URL");
    expect(baseUrl?.value).toBe("http://{{companion:ollama}}:11434");
    expect(baseUrl?.value).not.toMatch(/localhost|127\.0\.0\.1|host\.docker\.internal/);
  });

  test("generates its required secret rather than hardcoding one", () => {
    const secret = blueprint!.env.find((env) => env.key === "WEBUI_SECRET_KEY");
    expect(secret?.generate).toBe("password");
    expect(secret?.secret).toBe(true);
    expect(secret?.value).toBeUndefined();
  });

  test("asks for no cloud AI provider credentials in V1", () => {
    const keys = blueprint!.env.map((env) => env.key);
    for (const forbidden of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(blueprint!.env.find((env) => env.key === "ENABLE_OPENAI_API")?.value).toBe("false");
  });

  test("states minimum and recommended resources, and the CPU-only warning", () => {
    expect(blueprint!.resources).toEqual({
      minCpu: 4,
      minMemoryMb: 4096,
      minDiskGb: 10,
      recommendedCpu: 6,
      recommendedMemoryMb: 8192,
      recommendedDiskGb: 20
    });
    expect(blueprint!.warning).toBe(
      "Blueprint runs AI models on your VPS CPU. Responses may generate gradually, especially on smaller servers."
    );
  });

  test("offers CPU-friendly model tiers spanning roughly 1B to 8B", () => {
    expect(blueprint!.modelChoices).toBe(BLUEPRINT_MODEL_CHOICES);
    const ids = BLUEPRINT_MODEL_CHOICES.map((choice) => choice.id);
    expect(ids).toContain("llama3.2:1b");
    expect(ids).toContain("llama3.2:3b");
    expect(ids).toContain("llama3.1:8b");

    for (const choice of BLUEPRINT_MODEL_CHOICES) {
      // Every identifier must be a plain Ollama reference — these were
      // checked against registry.ollama.ai rather than invented.
      expect(choice.id).toMatch(/^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)?$/);
      expect(choice.sizeLabel).toBeTruthy();
    }
  });

  test("is recognised by the image classifier that shows the Blueprint tab", () => {
    expect(isBlueprintImage(blueprint!.image)).toBe(true);
    expect(isBlueprintImage(blueprint!.companions![0].image)).toBe(false);
  });
});

describe("resolveTemplatePlaceholders", () => {
  const companions = [{ key: "ollama", nameSuffix: "-ollama" }];

  test("resolves a companion reference to its real container name", () => {
    expect(
      resolveTemplatePlaceholders("http://{{companion:ollama}}:11434", "blueprint", companions)
    ).toBe("http://app-blueprint-ollama:11434");
  });

  test("follows the app name the operator chose, so repeat installs don't collide", () => {
    expect(
      resolveTemplatePlaceholders("http://{{companion:ollama}}:11434", "blueprint-2", companions)
    ).toBe("http://app-blueprint-2-ollama:11434");
    expect(companionAppName("blueprint-2", companions[0])).toBe("blueprint-2-ollama");
  });

  test("leaves an unknown key visible instead of silently emptying it", () => {
    expect(resolveTemplatePlaceholders("http://{{companion:nope}}:1", "x", companions)).toBe(
      "http://{{companion:nope}}:1"
    );
  });

  test("leaves ordinary values untouched", () => {
    expect(resolveTemplatePlaceholders("plain-value", "x", companions)).toBe("plain-value");
    expect(resolveTemplatePlaceholders("", "x", companions)).toBe("");
  });
});

describe("assessHostForTemplate", () => {
  const resources = blueprint!.resources!;

  test("flags a host below the stated minimum", () => {
    const result = assessHostForTemplate(resources, {
      cpuCount: 2,
      memoryTotalBytes: 2 * 1024 * 1024 * 1024
    });
    expect(result?.belowMinimum).toBe(true);
    expect(result?.shortfalls.join(" ")).toMatch(/4 GB RAM/);
    expect(result?.shortfalls.join(" ")).toMatch(/4 vCPU/);
  });

  test("flags a host that clears the minimum but not the recommendation", () => {
    const result = assessHostForTemplate(resources, {
      cpuCount: 4,
      memoryTotalBytes: 4 * 1024 * 1024 * 1024
    });
    expect(result?.belowMinimum).toBe(false);
    expect(result?.belowRecommended).toBe(true);
  });

  test("reports nothing to warn about on a well-sized host", () => {
    const result = assessHostForTemplate(resources, {
      cpuCount: 8,
      memoryTotalBytes: 16 * 1024 * 1024 * 1024
    });
    expect(result?.belowMinimum).toBe(false);
    expect(result?.belowRecommended).toBe(false);
    expect(result?.shortfalls).toEqual([]);
  });

  test("stays silent when host info is missing or nonsensical", () => {
    expect(assessHostForTemplate(resources, null)).toBeNull();
    expect(assessHostForTemplate(undefined, { cpuCount: 8, memoryTotalBytes: 1 })).toBeNull();
    expect(assessHostForTemplate(resources, { cpuCount: 0, memoryTotalBytes: 0 })).toBeNull();
  });

  test("formatGb renders whole and fractional sizes readably", () => {
    expect(formatGb(4096)).toBe("4 GB");
    expect(formatGb(1536)).toBe("1.5 GB");
  });
});

describe("existing templates are unaffected", () => {
  test("no other template gained companions or a badge", () => {
    const withCompanions = APP_TEMPLATES.filter((t) => (t.companions?.length ?? 0) > 0);
    expect(withCompanions.map((t) => t.id)).toEqual(["blueprint"]);

    const badged = APP_TEMPLATES.filter((t) => t.badge);
    expect(badged.map((t) => t.id)).toEqual(["blueprint"]);
  });

  test("every companion's app name stays a valid platform app slug", () => {
    const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const template of APP_TEMPLATES) {
      for (const companion of template.companions ?? []) {
        expect(companionAppName(template.suggestedName, companion)).toMatch(SLUG);
        expect(companion.key).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });
});
