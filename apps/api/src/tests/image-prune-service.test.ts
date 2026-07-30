import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { selectPrunableImages, type PruneImage } from "../services/image-prune-service.js";

function image(overrides: Partial<PruneImage> = {}): PruneImage {
  return { id: "sha256:" + Math.random().toString(16).slice(2), size: 100, repoTags: [], created: 0, ...overrides };
}

describe("selectPrunableImages", () => {
  test("selects dangling images", () => {
    const dangling = image({ id: "d1", repoTags: [] });
    const alsoDangling = image({ id: "d2", repoTags: ["<none>:<none>"] });
    const result = selectPrunableImages([dangling, alsoDangling], new Set(), 5);
    assert.deepEqual(result.map((i) => i.id).sort(), ["d1", "d2"]);
  });

  test("keeps the newest N build images per app and prunes the rest", () => {
    const images: PruneImage[] = [
      image({ id: "a-old", repoTags: ["deployment-app-5:aaa"], created: 100 }),
      image({ id: "a-mid", repoTags: ["deployment-app-5:bbb"], created: 200 }),
      image({ id: "a-new", repoTags: ["deployment-app-5:ccc"], created: 300 })
    ];
    const result = selectPrunableImages(images, new Set(), 1);
    // Keeps the newest (a-new); prunes the two older.
    assert.deepEqual(result.map((i) => i.id).sort(), ["a-mid", "a-old"]);
  });

  test("never prunes an image in use by a container", () => {
    const images: PruneImage[] = [
      image({ id: "a-old", repoTags: ["deployment-app-5:aaa"], created: 100 }),
      image({ id: "a-new", repoTags: ["deployment-app-5:bbb"], created: 300 })
    ];
    // a-old would be pruned (keep 1), but it's in use.
    const result = selectPrunableImages(images, new Set(["a-old"]), 1);
    assert.deepEqual(result, []);
  });

  test("never prunes non-build base images", () => {
    const images: PruneImage[] = [
      image({ id: "nginx", repoTags: ["nginx:alpine"], created: 100 }),
      image({ id: "pg", repoTags: ["postgres:16-alpine"], created: 100 })
    ];
    assert.deepEqual(selectPrunableImages(images, new Set(), 0), []);
  });

  test("scopes the keep-count per app", () => {
    const images: PruneImage[] = [
      image({ id: "a1", repoTags: ["deployment-app-5:x"], created: 100 }),
      image({ id: "b1", repoTags: ["deployment-app-9:y"], created: 100 })
    ];
    // keep 1 each: both apps have exactly 1, so nothing is pruned.
    assert.deepEqual(selectPrunableImages(images, new Set(), 1), []);
  });
});
