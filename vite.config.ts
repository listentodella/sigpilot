import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const direct = mode === "webusb";
  return {
    plugins: [react()],
    clearScreen: false,
    root: direct ? "webusb" : ".",
    publicDir: direct ? "../public" : "public",
    base: direct ? "./" : "/",
    build: {
      outDir: direct ? "../dist-webusb" : "dist",
      emptyOutDir: true,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: direct
          ? "webusb/index.html"
          : { main: "index.html", web: "web.html" },
      },
    },
    server: {
      host: "127.0.0.1",
      port: direct ? 1421 : 1420,
      strictPort: true,
      watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
    },
  };
});
