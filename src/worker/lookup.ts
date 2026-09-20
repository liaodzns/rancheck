/**
 * The question the product exists to answer, assembled.
 *
 * Candidate generation narrows, `matchNarrative` scores, this counts. Nothing
 * here matches anything itself — that would be a second matcher, and the whole
 * discipline of the port is that there is exactly one.
 */
import type { CorpusMeta, StoredCoin } from "../shared/types.js";
import { THRESHOLDS, type Thresholds } from "../shared/config.js";
import { matchCorpus, type CorpusMatch } from "./match-corpus.js";
import { ranEvidence, type RanEvidence } from "./ran.js";
import type { CandidateSubject, CorpusSource } from "./corpus.js";

/** One prior deployment, as the popover lists it. */
export interface PriorRun {
  mint: string;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  firstSeen: number;
  lastSeen: number;
  peakMcUsd: number | null;
  ran: boolean;
  evidence: RanEvidence;
  similarity: number;
  /** What was recognisable about the stored coin — never "these fields are equal". */
  matchedOn: CorpusMatch<never>["matchedOn"];
}

export interface LookupResult {
  mint: string;
  /** The badge's primary number: prior deployments that cleared the run bar. */
  ranCount: number;
  /** The badge's secondary number: prior deployments found at all. */
  totalCount: number;
  /** True when candidate generation truncated — a very large cluster. */
  capped: boolean;
  /**
   * Whether a number should be shown at all.
   *
   * False on a corpus too young for a 0 to mean anything. The caller must
   * render the corpus age instead, not a zero.
   */
  confident: boolean;
  corpusAgeMs: number;
  priors: PriorRun[];
}

/**
 * Count prior deployments of one subject.
 *
 * The badge reads `ranCount / totalCount` — `3 / 47`. Both are floors: the
 * corpus only ever saw what was on screen, so a coin that ran unobserved is
 * counted as a deployment and not as a run. Nothing downstream may phrase
 * either number as though it were complete.
 */
export async function lookup(
  subject: CandidateSubject,
  source: CorpusSource,
  thresholds: Thresholds = THRESHOLDS,
  now: number = Date.now(),
): Promise<LookupResult> {
  const [{ coins, capped }, meta] = await Promise.all([
    source.candidatesFor(subject),
    source.meta(),
  ]);

  const matches = matchCorpus(
    { name: subject.name ?? "", symbol: subject.symbol ?? "", uri: "" },
    coins.map((coin) => ({
      mint: coin.mint,
      name: coin.name ?? "",
      symbol: coin.symbol ?? "",
      // Deliberately not the image URL. An identical URL is a usable proxy for
      // an identical token, but it is not a metadata URI, and routing it
      // through the metadata shortcut would report `matchedOn: ["metadata"]`
      // for something that is not that. Images get their own path in phase 4.
      uri: undefined,
    })),
    thresholds.narrative,
    { excludeMint: subject.mint },
  );

  const byMint = new Map(coins.map((coin) => [coin.mint, coin]));
  const priors = matches.map((match) =>
    toPriorRun(byMint.get(match.candidate.mint) as StoredCoin, match, thresholds),
  );

  return {
    mint: subject.mint,
    ranCount: priors.filter((prior) => prior.ran).length,
    totalCount: priors.length,
    capped,
    confident: isConfident(meta, thresholds, now),
    corpusAgeMs: corpusAge(meta, now),
    priors,
  };
}

/** The shape `matchCorpus` was handed: a stored coin flattened for scoring. */
type ScoredCandidate = { mint: string; name: string; symbol: string; uri?: string | undefined };

function toPriorRun(
  coin: StoredCoin,
  match: CorpusMatch<ScoredCandidate>,
  thresholds: Thresholds,
): PriorRun {
  return {
    mint: coin.mint,
    name: coin.name,
    symbol: coin.symbol,
    imageUrl: coin.imageUrl,
    firstSeen: coin.firstSeen,
    lastSeen: coin.lastSeen,
    peakMcUsd: coin.peakMcUsd,
    ran: coin.ran,
    evidence: ranEvidence(coin, thresholds.ran),
    similarity: match.similarity,
    matchedOn: match.matchedOn,
  };
}

/** Milliseconds this corpus has been watching. Zero on a fresh install. */
export function corpusAge(meta: CorpusMeta, now: number): number {
  if (meta.startedAt === 0) return 0;
  return Math.max(0, now - meta.startedAt);
}

/**
 * Whether a count from this corpus is worth showing.
 *
 * The failure this prevents is specific and bad: on a three-day-old corpus
 * every badge reads 0, and a user reads that as "never been run" when it means
 * "we started watching on Tuesday". Those are opposite conclusions drawn from
 * the same glyph, and the wrong one is the confident-looking one.
 */
export function isConfident(meta: CorpusMeta, thresholds: Thresholds, now: number): boolean {
  return corpusAge(meta, now) >= thresholds.corpus.minAgeMsForBadge;
}
