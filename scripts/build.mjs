/**
 * Bundle the extension into `dist/`.
 *
 * esbuild rather than a framework: there is no framework here to serve. The
 * content script is one entry point with no dependencies outside this repo, and
 * a bundler that takes 30ms is worth more than one with a plugin ecosystem.
 *
 * `--watch` rebuilds on change; Chrome still needs the extension reloaded.
 */
import { build, context } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: { content: "src/content/index.ts", worker: "src/worker/index.ts" },
  outdir: "dist",
  bundle: true,
  format: "iife",
  // Chrome's extension APIs and the DOM are both current; there is no reason to
  // downlevel and every reason not to obscure what shipped.
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

mkdirSync("dist", { recursive: true });
copyFileSync("manifest.json", "dist/manifest.json");

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching; reload the extension in chrome://extensions after each build");
} else {
  await build(options);
}
