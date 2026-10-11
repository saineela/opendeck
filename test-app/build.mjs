/**
 * Bundles test-app/engine-entry.ts into test-app/vendor/engine.js.
 * Run from webapp/:  node test-app/build.mjs
 */
import { build } from "esbuild";

await build({
  entryPoints: ["test-app/engine-entry.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: "test-app/vendor/engine.js",
  sourcemap: false,
  // import.meta.env is a Vite convention used by internal/logging.ts; the
  // bare app is a plain static bundle, so we pin it at build time.
  define: {
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "true",
    "import.meta.env.MODE": '"production"',
  },
  jsx: "automatic",
  logLevel: "info",
});

console.log("[test-app] engine bundle written to test-app/vendor/engine.js");
