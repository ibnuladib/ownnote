import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// Vite root is src/web; the Worker serves ./dist as static assets.
// During `vite` dev, /api is proxied to `wrangler dev` (npm run worker:dev).
export default defineConfig({
  root: p("./src/web"),
  publicDir: p("./public"),
  plugins: [react()],
  resolve: {
    alias: { "@shared": p("./src/shared") },
  },
  server: {
    port: 5173,
    proxy: {
      // "/api/" (not "/api") so the src/web/api.ts module isn't swallowed by the proxy.
      "/api/": {
        target: "http://localhost:8787",
        changeOrigin: false,
        // wrangler dev is plain http; the Secure session cookie is still
        // accepted by browsers on localhost.
        secure: false,
      },
    },
  },
  build: {
    outDir: p("./dist"),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
