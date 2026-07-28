import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// `test.globals` is intentionally false (see vitest.config.ts), so
// @testing-library/react cannot auto-register its usual afterEach cleanup —
// do it explicitly here so every test starts from an empty DOM.
afterEach(() => {
  cleanup();
});
