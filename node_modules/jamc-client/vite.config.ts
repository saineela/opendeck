/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The API reference is rendered by the server. Without this the
      // Settings → "API docs" link resolves against the Vite origin and gets
      // the SPA shell back instead of the docs.
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
      "/docs": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
      "/docs": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
