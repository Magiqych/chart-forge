import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri serves the built frontend from a fixed port during development and expects the
// production bundle in dist/. Nothing here reaches outside editor/.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
