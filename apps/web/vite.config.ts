import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Stamp a fresh build id into every build so each deploy produces a new
  // bundle — this is what the in-browser update check detects.
  //
  // __APP_VERSION__ is the deployed image version (e.g. "0.1.141"), passed in
  // at image-build time via the APP_VERSION build arg (see apps/web/Dockerfile
  // and the release/installer build paths). It is the human-facing version
  // shown on the Updates screen. Falls back to "dev" for a local build.
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(process.env.VITE_APP_VERSION || "dev"),
    __APP_COMMIT__: JSON.stringify(process.env.VITE_APP_COMMIT || "unknown")
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  }
});
