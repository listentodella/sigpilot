import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
export default defineConfig({
  root:fileURLToPath(new URL(".",import.meta.url)),
  define:{"process.env.NODE_ENV":JSON.stringify("production")},
  resolve:{alias:{"@tauri-apps/api/core":fileURLToPath(new URL("./core.ts",import.meta.url))}},
  build:{emptyOutDir:true,lib:{entry:fileURLToPath(new URL("./entry.ts",import.meta.url)),fileName:"entry",formats:["es"]},
    minify:false,outDir:fileURLToPath(new URL("./dist",import.meta.url)),target:"es2022"},
});
