import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite/analyzer-markers-demo", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
});
