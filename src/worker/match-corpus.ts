/**
 * Matching one launch against a corpus.
 *
 * argus asks a different question: it holds one parent — the coin you just
 * bought — and asks whether an incoming launch is a clone of it. One against
 * one. Here there is no parent. There is a row on your screen and fifty
 * thousand coins you have seen before, and the question is how many of them it
 * is the same thing as.
 *
 * That is a different shape, but it is not different matching, so nothing below
 * reimplements any of it. `matchNarrative` keeps its signature exactly and is
 * called once per candidate, with the corpus entry standing in the parent's
 * place. Everything this file adds is iteration, self-exclusion and ordering.
 *
 * The candidate list is the thing that makes this affordable, and it is not
 * built here. Passing the whole corpus in would be 40 rows × 50k entries of
 * Jaro-Winkler per feed tick, which kills the tab. `index-store.ts` (phase 3)
 * retrieves a few dozen plausible candidates by blocking on normalised forms,
 * trigrams and phash bands; this file scores whatever it is handed and does not
 * care how the list was narrowed. That separation is why the naive version
 * below stays correct — it is only ever slow, never wrong.
 */
import { matchNarrative, type NarrativeConfig, type NarrativeMatchResult } from "./match.js";
import type { Address, MintEvent, NarrativeMatch } from "../shared/types.js";

/**
 * The least a corpus entry must carry to be matchable.
 *
 * Structurally identical to what `matchNarrative` reads off a parent, plus the
 * mint, which is here so self-matches can be dropped and results keyed. A
 * stored coin satisfies this; so does a raw fixture launch, which is what lets
 * phase 1 run the real corpus path with no storage layer in existence yet.
 */
export interface NarrativeCandidate {
  mint: Address;
  name: string;
  symbol: string;
  /** Empty string when unknown. Never a placeholder — see the guard below. */
  uri?: string | undefined;
}

export interface CorpusMatch<T extends NarrativeCandidate> extends NarrativeMatchResult {
  candidate: T;
}

/**
 * Score one subject against a candidate list, best first.
 *
 * Self-exclusion is by mint, not by identity, because the subject is usually a
 * freshly scraped observation while the candidate is a stored row, and those
 * are different objects describing the same coin. Comparing a coin to itself
 * would score 1.0 and inflate every count by exactly one.
 *
 * Ties are broken by mint so the order is stable across runs. The alternative
 * is input order, which is IndexedDB cursor order, which is not something the
 * UI should be quietly depending on.
 */
export function matchCorpus<T extends NarrativeCandidate>(
  subject: Pick<MintEvent, "name" | "symbol" | "uri">,
  candidates: readonly T[],
  config: NarrativeConfig,
  options: { excludeMint?: Address | undefined } = {},
): Array<CorpusMatch<T>> {
  const matches: Array<CorpusMatch<T>> = [];

  for (const candidate of candidates) {
    if (options.excludeMint !== undefined && candidate.mint === options.excludeMint) continue;

    // The corpus entry takes the parent's position: `matchedOn` then names what
    // was recognisable about the *stored* coin, which is the direction the
    // popover reads in — "you have seen this name before", not "this new coin
    // has a name".
    const result = matchNarrative(
      { name: candidate.name, symbol: candidate.symbol, uri: candidate.uri },
      subject,
      config,
    );
    if (result === null) continue;
    matches.push({ ...result, candidate });
  }

  matches.sort((a, b) =>
    b.similarity - a.similarity || a.candidate.mint.localeCompare(b.candidate.mint),
  );
  return matches;
}

/**
 * Group a set of launches into clusters of things that match each other.
 *
 * Single-link: A and C land in one cluster if both match B, even when they do
 * not match each other. That is the correct linkage for this data and not a
 * convenience. The recorded Thursday Arena wave contains rows named `Cupcake`
 * with ticker `CUPCAKE` and rows named `thursdayarena` with ticker `THURSDAY`,
 * which share nothing; they are one wave only because rows named
 * `thursdayarena` with ticker `CUPCAKE` sit between them and match both. Demand
 * that every member match every other and the wave splits into the pieces its
 * deployer was mutating between, which is the opposite of what a count means.
 *
 * O(n²), and deliberately so. This exists to characterise a fixture in tests
 * and to answer "what did this cluster to" offline. It is not on the hot path
 * and must never be put there — the badge counts matches against one subject,
 * which is `matchCorpus` over a narrowed candidate list.
 */
export function clusterByNarrative<T extends NarrativeCandidate>(
  launches: readonly T[],
  config: NarrativeConfig,
): Array<T[]> {
  const parent = new Map<Address, Address>();
  const find = (x: Address): Address => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as Address;
    // Path compression, so a long chain does not make this quadratic in depth
    // as well. A wave is exactly the long chain this protects against.
    let walk = x;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk) as Address;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (a: Address, b: Address): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const launch of launches) parent.set(launch.mint, launch.mint);

  for (let i = 0; i < launches.length; i++) {
    const a = launches[i] as T;
    for (let j = i + 1; j < launches.length; j++) {
      const b = launches[j] as T;
      if (find(a.mint) === find(b.mint)) continue;
      const hit = matchNarrative(
        { name: a.name, symbol: a.symbol, uri: a.uri },
        { name: b.name, symbol: b.symbol, uri: b.uri ?? "" },
        config,
      );
      if (hit !== null) union(a.mint, b.mint);
    }
  }

  const clusters = new Map<Address, T[]>();
  for (const launch of launches) {
    const root = find(launch.mint);
    const bucket = clusters.get(root);
    if (bucket === undefined) clusters.set(root, [launch]);
    else bucket.push(launch);
  }
  return [...clusters.values()].sort((a, b) => b.length - a.length);
}

export type { NarrativeConfig, NarrativeMatchResult, NarrativeMatch };
