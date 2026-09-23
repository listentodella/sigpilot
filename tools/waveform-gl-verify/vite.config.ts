import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// Bundles the real production worker into a plain ES module so a browser page
// can drive it directly. See run.sh for the full harness.
export default defineConfig({
  root,
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
