import { defineConfig } from "vite";
// One content script bundled as a classic script; the manifest is copied from public/.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: "src/content.ts",
      formats: ["iife"],
      name: "PacedExtension",
      fileName: () => "content.js",
    },
  },
});
