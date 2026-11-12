import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// Bundles the real WaveformAnnotationsOverlay so a browser page can mount it with
// a synthetic fixture and assert the rendered DOM, icon pixels and interactions.
export default defineConfig({
  root,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite/annotation-overlay-verify", import.meta.url)),
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
