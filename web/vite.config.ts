import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Local API target, shared by `vite dev` and `vite preview`. */
const API_PROXY = { "/api": "http://127.0.0.1:8000" };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    /**
     * drizzle-orm (API workspace) still declares a React 18 peer, so npm keeps
     * a second React hoisted at the repo root. Any dependency that also lands
     * at the root — lucide-react today — would resolve *that* copy and ship two
     * Reacts in one bundle, which breaks hooks and context in ways that only
     * show up at runtime. Pin resolution to the app's own copy.
     */
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5173,
    // Proxy API calls to the local Node API in dev, mirroring the same-origin
    // setup Netlify provides in production (so there are no CORS hoops).
    proxy: API_PROXY,
  },
  /**
   * `vite preview` does NOT read `server.proxy`, so without this every
   * `/api/v1/*` call fell through to the SPA fallback and came back as
   * index.html with a 200 — surfacing as "JSON.parse: unexpected character at
   * line 1 column 1" instead of anything actionable.
   */
  preview: {
    proxy: API_PROXY,
  },
});
