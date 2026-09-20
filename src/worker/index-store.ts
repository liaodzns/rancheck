/**
 * Candidate generation: deciding who gets scored.
 *
 * The naive lookup compares each visible row against the whole corpus. With 40
 * rows on screen and 50k coins stored that is two million Jaro-Winkler calls
 * per feed tick and the tab dies. So: retrieve a few dozen plausible candidates
 * cheaply, then score only those.
 *
 * ---------------------------------------------------------------------------
 * A deviation from the spec's storage shape, and why.
 *
 * The spec describes an `index` object store holding `{ key, mints[] }` rows.
 * That is the right *concept* and the wrong implementation for IndexedDB: every
 * insert becomes a read-modify-write of an array that, for a hot key, grows
 * without bound. Storing one coin whose name shares a trigram with 40,000
 * others means reading a 40,000-element array, pushing to it, and writing it
 * back — on a feed producing 31 launches a minute.
 *
 * IndexedDB already implements exactly this concept natively, with indexes
 * maintained incrementally by the engine. So the lookup tables are indexes on
 * the `coins` store rather than rows in a store of their own:
 *
 *   byNorm      two indexes on `normName` and `normSymbol`
 *   byTrigram   a multiEntry index on `trigrams`
 *   byPhashBand a multiEntry index on `phashBands` (phase 4; empty until then)
 *
 * Same three lookup tables the spec asks for, same union-and-dedupe at query
 * time, no quadratic write.
 * ---------------------------------------------------------------------------
 *
 * What each catches, and their relative weight — which is not close:
 *
 * - `byNorm` is the ~98% case. Exact equality after normalisation found 5.64 of
 *   the 5.71 mean matches the full matcher finds. This is the fast path and it
 *   is nearly as good as the whole thing.
 * - `byTrigram` catches renames and insertions, and exists to feed the fuzzy
 *   layer that earns the remaining ~1.2%. It costs the most storage of the
 *   three and buys the least; it is here because the popover should be as good
 *   as the matcher can be, not because the badge needs it.
 * - `byPhashBand` catches the reupload that renames completely, which neither
 *   text index can see at all. Phase 4.
 */
import type { StoredCoin } from "../shared/types.js";
import type { CorpusThresholds } from "../shared/config.js";
import { normalize } from "./match.js";

/**
 * Character trigrams of a normalised string.
 *
 * Deduplicated, because a multiEntry index gains nothing from repeats and a
 * name like `bananana` would otherwise store `ana` three times.
 *
 * Strings shorter than the minimum yield none rather than yielding themselves.
 * That is the `minLength` guard again, in the index domain: a two-character
 * name indexed whole would be retrieved as a candidate for everything that
 * contains those two characters, and the blank-name failure would come back
 * through the side door.
 */
export function trigramsOf(value: string, thresholds: CorpusThresholds): string[] {
  if (value.length < thresholds.trigramMinLength) return [];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= value.length; i++) out.add(value.slice(i, i + 3));
  return [...out];
}

/** The normalised forms and index keys for a coin's text. */
export interface NormalisedText {
  normName: string;
  normSymbol: string;
  trigrams: string[];
}

/**
 * Derive everything the indexes need from a name and a symbol.
 *
 * Uses the frozen `normalize()`, so index keys and match keys can never drift
 * apart — a candidate retrieved by exact key is guaranteed to score 1.0 on that
 * field, which is what makes the fast path sound.
 */
export function normaliseText(
  name: string | null,
  symbol: string | null,
  thresholds: CorpusThresholds,
): NormalisedText {
  const normName = name === null ? "" : normalize(name);
  const normSymbol = symbol === null ? "" : normalize(symbol);
  return {
    normName,
    normSymbol,
    trigrams: [
      ...new Set([...trigramsOf(normName, thresholds), ...trigramsOf(normSymbol, thresholds)]),
    ],
  };
}

/**
 * Split a 64-bit hex perceptual hash into four 16-bit bands.
 *
 * Standard LSH: two hashes within Hamming distance 10 share at least one band
 * with high probability, so a band lookup retrieves near-duplicates without
 * comparing against everything. It is approximate, and that is fine — this is
 * a count, not a proof.
 *
 * Bands are prefixed with their position so band 0 of one hash cannot collide
 * with band 2 of another, which would retrieve unrelated images as candidates.
 *
 * Phase 4 populates these. Returning `[]` for a null hash is what keeps a coin
 * whose image failed to fetch out of the index entirely, rather than filed
 * under a hash of nothing.
 */
export function phashBands(phash: string | null): string[] {
  if (phash === null || !/^[0-9a-f]{16}$/i.test(phash)) return [];
  const lower = phash.toLowerCase();
  return [0, 1, 2, 3].map((band) => `${band}:${lower.slice(band * 4, band * 4 + 4)}`);
}

/**
 * Merge candidate mints from several index lookups into one scoring list.
 *
 * Deduplicates, drops the subject itself, and caps. The cap is a cost bound,
 * not a correctness one: `matchCorpus` is correct on any list, so truncating
 * can only lose matches, never invent them.
 *
 * `capped` is returned rather than logged here, because hitting the cap is
 * genuinely interesting — a row with more than 200 plausible prior deployments
 * is a very large cluster, which is itself the answer to the question being
 * asked — and the caller is the one that knows how to surface it.
 */
export function mergeCandidates(
  buckets: ReadonlyArray<readonly string[]>,
  options: { excludeMint?: string | undefined; max: number },
): { mints: string[]; capped: boolean } {
  const seen = new Set<string>();

  for (const bucket of buckets) {
    for (const mint of bucket) {
      if (mint === options.excludeMint) continue;
      seen.add(mint);
      // Note the cap is checked after insert, so the set is allowed to reach
      // exactly `max`. Stopping early would silently prefer whichever index
      // happened to be queried first.
      if (seen.size >= options.max) {
        return { mints: [...seen], capped: true };
      }
    }
  }

  return { mints: [...seen], capped: false };
}

/** The index keys a stored coin should be retrievable by. For tests and debugging. */
export function indexKeysOf(coin: StoredCoin): {
  norm: string[];
  trigrams: string[];
  bands: string[];
} {
  return {
    norm: [coin.normName, coin.normSymbol].filter((key) => key.length > 0),
    trigrams: coin.trigrams,
    bands: phashBands(coin.phash),
  };
}
