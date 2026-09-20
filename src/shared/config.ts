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

export interface RanThresholds {
  /** Peak market cap at or above which a coin counts as having run. */
  minPeakMcUsd: number;
}

export interface CorpusThresholds {
  /** Below this age, a count of 0 is not information and no badge is shown. */
  minAgeMsForBadge: number;
  /** Coins that never ran are dropped after this long. Ones that ran never are. */
  retentionMs: number;
  /** Trigrams are stored per coin; below this length a string yields none. */
  trigramMinLength: number;
}

export interface CandidateThresholds {
  /** Most candidates scored for one row before the list is truncated. */
  maxPerRow: number;
}

export interface Thresholds {
  narrative: NarrativeThresholds;
  narrativeWithImage: NarrativeThresholds;
  ran: RanThresholds;
  corpus: CorpusThresholds;
  candidates: CandidateThresholds;
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

  ran: {
    // A GUESS, and the spec says so. It is also the single number that decides
    // whether this product is useful or noise: because matching is bimodal, a
    // popular ticker matches dozens of dead deployments, and "deployed 47
    // times" is a fact nobody needs. "Ran 3 times out of 47" is the trade.
    //
    // Too low and every wave member counts as a run, so the badge says
    // everything has run and means nothing. Too high and it reports zero on
    // coins that plainly did something. Expect to move it once there is a
    // corpus with a few weeks in it to look at.
    minPeakMcUsd: 100_000,
  },

  corpus: {
    // A count of 0 against a corpus that started on Tuesday is not information,
    // and a user will read it as "never been run". Below this age the badge
    // says how old the corpus is instead of showing a number.
    //
    // Three days is a guess at when self-accumulated counts start meaning
    // something. At roughly 45k launches/day with a feed open it is ~135k
    // coins, which is past the point where a repeat ticker is unremarkable.
    //
    // Dropping this to ~60s is the way to exercise the badge by hand; do not
    // leave it dropped, and never set it to 0 — at zero an empty corpus reports
    // age 0, passes the gate, and confidently renders `0 / 0`, which is the one
    // reading that actively misleads.
    minAgeMsForBadge: 3 * 24 * 60 * 60 * 1000,
    // Thirty days of never-ran coins. A coin that ran is the whole point of the
    // corpus and is never evicted, whatever its age.
    retentionMs: 30 * 24 * 60 * 60 * 1000,
    // Matches `narrative.minLength`, and for the same reason: a string too
    // short to compare is too short to index.
    trigramMinLength: 3,
  },

  candidates: {
    // Scoring is Jaro-Winkler per candidate, so this bounds the per-row cost.
    // Hitting it is not an error and is worth logging rather than hiding: a row
    // with more than 200 plausible prior deployments is itself the answer to
    // the question being asked.
    maxPerRow: 200,
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
