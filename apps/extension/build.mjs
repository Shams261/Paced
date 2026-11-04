// Builds each entry as its own classic script (content scripts and the options page) and the
// background worker as a module; the manifest and options page are copied from public/.
import { build } from "vite";
const entries = [
  ["src/content.ts", "content.js", "iife"],
  ["src/observe.ts", "observe.js", "iife"],
  ["src/options.ts", "options.js", "iife"],
  ["src/worker.ts", "worker.js", "es"],
];
let first = true;
for (const [entry, fileName, format] of entries) {
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: "dist",
      emptyOutDir: first,
      copyPublicDir: first,
      sourcemap: false,
      minify: false,
      lib: {
        entry,
        formats: [format],
        name: "PacedExtension",
        fileName: () => fileName,
      },
    },
  });
  first = false;
}
console.log("extension built: " + entries.map((e) => e[1]).join(", "));
