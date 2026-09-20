/**
 * Bundle the extension into `dist/`.
 *
 * esbuild rather than a framework: there is no framework here to serve. Each
 * entry point has no dependencies outside this repo, and a bundler that takes
 * 30ms is worth more than one with a plugin ecosystem.
 *
 * **Two output formats, on purpose.** The worker is declared
 * `"type": "module"` in the manifest and the options page loads via
 * `<script type="module">`, so both are ESM. A content script is neither — MV3
 * injects it as a classic script, and an ESM bundle there fails at load with an
 * error that points at the file rather than at the format.
 *
 * `--watch` rebuilds on change; Chrome still needs the extension reloaded.
 */
import { build, context } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

const shared = {
  outdir: "dist",
  bundle: true,
  // Chrome's extension APIs and the DOM are both current; there is no reason to
  // downlevel and every reason not to obscure what shipped.
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

const builds = [
  // Injected into the page as a classic script.
  { ...shared, entryPoints: { content: "src/content/index.ts" }, format: "iife" },
  // Both loaded as modules by Chrome.
  {
    ...shared,
    entryPoints: { worker: "src/worker/index.ts", options: "src/options/index.ts" },
    format: "esm",
  },
];

mkdirSync("dist", { recursive: true });
copyFileSync("manifest.json", "dist/manifest.json");
copyFileSync("src/options/index.html", "dist/options.html");

if (watch) {
  for (const options of builds) {
    const ctx = await context(options);
    await ctx.watch();
  }
  console.log("watching; reload the extension in chrome://extensions after each build");
} else {
  await Promise.all(builds.map((options) => build(options)));
}
