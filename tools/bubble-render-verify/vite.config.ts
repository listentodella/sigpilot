import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// Bundles the real AnalyzerBubblesOverlay so a browser page can mount it with a
// synthetic fixture and time the bubble-list rebuild directly.
export default defineConfig({
  root,
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
