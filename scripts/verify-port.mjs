/**
 * Prove `src/worker/match.ts` is still argus's `narrative.ts`.
 *
 * The port's value is that it was not edited. That is an easy claim to make and
 * an easy one to quietly break six months from now, so it is checked rather
 * than asserted: strip our header banner, diff the rest, and allow exactly one
 * changed line — the import path.
 *
 * Skips with a notice when the argus checkout is absent. argus is gitignored
 * and is not a dependency; this check is for whoever has it, not a gate on
 * whoever does not.
 */
import { readFileSync, existsSync } from "node:fs";

const ARGUS = "argus/packages/engine/src/narrative.ts";
const PORT = "src/worker/match.ts";
const ALLOWED = new Set([
  'import type { MintEvent, NarrativeMatch, TokenMeta } from "../shared/types.js";',
]);

if (!existsSync(ARGUS)) {
  console.log(`skip: no argus checkout at ${ARGUS}; nothing to diff against.`);
  process.exit(0);
}

const port = readFileSync(PORT, "utf8").split("\n");
const origin = readFileSync(ARGUS, "utf8").split("\n");

// Drop our banner: everything up to and including the first `*/`.
const bannerEnd = port.findIndex((line) => line.trim() === "*/");
const body = port.slice(bannerEnd + 1);

const drift = [];
for (let i = 0; i < Math.max(body.length, origin.length); i++) {
  const a = body[i] ?? "<missing>";
  const b = origin[i] ?? "<missing>";
  if (a === b || ALLOWED.has(a.trim())) continue;
  drift.push(`  line ${i + 1}\n    port:  ${a}\n    argus: ${b}`);
}

if (drift.length > 0) {
  console.error(`${PORT} has drifted from ${ARGUS}:\n${drift.join("\n")}`);
  console.error(
    "\nThe port is meant to be verbatim. If argus changed, re-copy it; if you\n" +
      "changed the port, move the change into match-corpus.ts instead.",
  );
  process.exit(1);
}

console.log(`ok: ${PORT} is verbatim against ${ARGUS} (import path aside).`);
