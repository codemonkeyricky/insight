import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API server listens on 4317 by default. Override with INSIGHT_API when it runs elsewhere.
const api = process.env.INSIGHT_API ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: api, changeOrigin: false } },
  },
  // Cytoscape is most of the bundle. It is loaded with the lens pages only when they are opened.
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
});
