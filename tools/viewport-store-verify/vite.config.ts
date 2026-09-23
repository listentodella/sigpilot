import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// Bundles the real viewport store, the real hook and a probe component so a
// browser page can assert the render-isolation claim directly.
export default defineConfig({
  root,
  // React's production entry reads process.env.NODE_ENV; there is no Node in the
  // browser, so bake it in.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./entry.ts", import.meta.url)),
      fileName: "entry",
      formats: ["es"],
    },
    minify: false,
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    target: "es2022",
  },
});
