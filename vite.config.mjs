import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";

// Inject the single-source-of-truth version (package.json) into the panel bundle
// so the UI can display it in both Electron and web modes without an IPC round-trip.
const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));

export default defineConfig({
  root: path.resolve("src/panel"),
  base: "./",
  define: {
    __ZHUZHU_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve("dist/panel"),
    emptyOutDir: true,
    // v1.8 perf: split the vendor libraries out of the single 1.8MB entry chunk.
    // The panel is loaded from disk so download time is not the issue — parse and
    // compile time on the renderer's main thread is, and it is paid again on
    // every panel reload (including the crash-recovery reload added in v1.8).
    // Splitting also means an app-code change no longer invalidates the cached
    // compilation of React, Recharts and CodeMirror.
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-dom/client"],
          "vendor-charts": ["recharts"],
          "vendor-editor": ["@uiw/react-codemirror", "@codemirror/lang-json"],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@panel": path.resolve("src/panel"),
    },
  },
});
