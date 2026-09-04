import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify("test"),
    __APP_VERSION__: JSON.stringify("0.0.0-test")
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
    globals: false,
    css: false
  }
});
