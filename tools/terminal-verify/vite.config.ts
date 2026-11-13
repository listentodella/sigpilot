import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: fileURLToPath(new URL("./dist", import.meta.url)), emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./check.html", import.meta.url)) } },
});
