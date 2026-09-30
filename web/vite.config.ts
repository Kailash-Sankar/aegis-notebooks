import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /api/* to the runner so the browser sees a single origin (and the
// runner stays bound to localhost). The runner routes have no /api prefix.
export default defineConfig({
  plugins: [react()],
  build: {
    // Astryx's component library is one large vendor chunk (~530 kB).
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Split heavy vendors so the initial bundle stays small and
        // rarely-changing deps stay cached across app deploys.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@astryxdesign")) return "astryx";
          if (id.includes("recharts")) return "charts";
          if (id.includes("victory-vendor") || id.includes("/d3-")) return "d3";
          if (id.includes("lucide-react")) return "icons";
          if (
            id.includes("/react-dom/") ||
            id.includes("/react/") ||
            id.includes("/scheduler/")
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
