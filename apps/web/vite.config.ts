import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Stamp a fresh build id into every build so each deploy produces a new
  // bundle — this is what the in-browser update check detects.
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString())
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
