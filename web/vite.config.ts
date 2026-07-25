import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Proxy API calls to the local Node API in dev, mirroring the same-origin
    // setup Netlify provides in production (so there are no CORS hoops).
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
});
