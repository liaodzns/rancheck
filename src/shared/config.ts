/**
 * Every tunable number, in one file, with the reason next to it.
 *
 * This mirrors the practice of argus `config/thresholds.yml`, including its
 * opening warning, which is worth repeating: most of these are guesses. The
 * ones that are not say so explicitly and name what measured them. Do not
 * re-tune a measured value without a recording to tune against — guessing at a
 * live feed is how you convince yourself of something false.
 *
 * argus hot-reloads its YAML. An extension cannot, so this is a TS module and
 * changing it means a reload. That is fine; these move rarely.
 */

export interface NarrativeThresholds {
  /** Similarity at or above which a pairing counts as a match. */
  minSimilarity: number;
  /** Shortest normalised string worth comparing. */
  minLength: number;
}

export interface Thresholds {
  narrative: NarrativeThresholds;
  narrativeWithImage: NarrativeThresholds;
}

export const THRESHOLDS: Thresholds = {
  narrative: {
    // MEASURED, against 123 real launches on 2026-09-17. The value barely
    // matters: normalisation turns most clones into exact matches and the
    // result is bimodal — half of all launches match nothing, a wave member
    // matches ~26 — so the threshold sits in a wide empty gap.
    minSimilarity: 0.9,
    // LOAD-BEARING, not defensive. Blank names are real (7 of the 123 sampled
    // launches) and two blanks score 1.0, so without this a nameless token
    // matches every row on screen. Do not remove it.
    minLength: 3,
  },

  narrativeWithImage: {
    // argus's `signals.vamp_of_runner.min_similarity`. A looser text bar, for
    // cases where an image phash agrees as well and text is corroboration
    // rather than the whole case. Unused until phase 4 has hashes to agree
    // with; carried now so the pair of numbers stays in one place.
    minSimilarity: 0.72,
    minLength: 3,
  },
};

/**
 * The argus deep link, and the entire Axiom integration.
 *
 * Axiom has no official public API. Every third-party SDK claiming otherwise is
 * reverse-engineered: they drive headless Chrome to defeat Cloudflare Turnstile
 * and ask for an account password plus IMAP credentials to read login OTPs out
 * of an inbox. None of that goes anywhere near this project. This extension
 * reads DOM in a session you logged into yourself and never sees a credential.
 *
 * The mint in that URL is also the primary key: every Axiom row links to
 * `/meme/<mint>`, which survives any DOM redesign, so the scraper is built
 * around finding it.
 */
export function axiomLink(mint: string): string {
  return `https://axiom.trade/meme/${encodeURIComponent(mint)}`;
}
