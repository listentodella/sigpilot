import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)), base: "./", plugins: [react()],
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite/protocol-trigger-verify", import.meta.url)),
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
});
