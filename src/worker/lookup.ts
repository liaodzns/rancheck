/**
 * The question the product exists to answer, assembled.
 *
 * Candidate generation narrows, `matchNarrative` scores, this counts. Nothing
 * here matches anything itself — that would be a second matcher, and the whole
 * discipline of the port is that there is exactly one.
 */
import type { CorpusMeta, NarrativeMatch, StoredCoin } from "../shared/types.js";
import { THRESHOLDS, type Thresholds } from "../shared/config.js";
import { matchCorpus } from "./match-corpus.js";
import { hammingDistance } from "./phash.js";
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
  matchedOn: NarrativeMatch[];
  /**
   * Hamming distance between the two images, out of 64 bits.
   *
   * Null when either side has no hash, which the popover must render as "not
   * compared" rather than as a difference. A failed hash is never a statement
   * about whether two pictures match.
   */
  imageDistance: number | null;
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
  // The subject's own hash is read from storage rather than passed in. The
  // content script cannot compute one — hashing a cross-origin image taints the
  // page's canvas — so by the time a lookup runs, the hash either exists in the
  // corpus from an earlier pass or does not exist yet.
  const subjectPhash =
    subject.phash !== undefined
      ? subject.phash
      : ((await source.getMany([subject.mint]))[0]?.phash ?? null);

  const [{ coins, capped }, meta] = await Promise.all([
    source.candidatesFor({ ...subject, phash: subjectPhash }),
    source.meta(),
  ]);

  const flattened = coins.map((coin) => ({
    mint: coin.mint,
    name: coin.name ?? "",
    symbol: coin.symbol ?? "",
    // Deliberately not the image URL. An identical URL is a usable proxy for an
    // identical token, but it is not a metadata URI, and routing it through the
    // metadata shortcut would report `matchedOn: ["metadata"]` for something
    // that is not that. Images have their own path, below.
    uri: undefined,
  }));

  const subjectText = { name: subject.name ?? "", symbol: subject.symbol ?? "", uri: "" };

  // Scored twice, at two bars, and the second pass is not redundant.
  //
  // Text alone has to clear 0.90. Text *corroborating an image match* only has
  // to clear 0.72 — argus's `vamp_of_runner.min_similarity`, the looser bar it
  // uses precisely when a phash is also in play. Running one pass at the looser
  // bar and filtering would not do: `matchedOn` means "what was recognisable",
  // and at 0.72 that is a weaker claim than at 0.90, so a strict match would
  // end up reporting a looser recognition than it earned.
  //
  // The cost is one extra Jaro-Winkler sweep over at most 200 candidates, which
  // is nothing beside the IndexedDB reads that fetched them.
  const strict = new Map(
    matchCorpus(subjectText, flattened, thresholds.narrative, { excludeMint: subject.mint }).map(
      (match) => [match.candidate.mint, match],
    ),
  );
  const loose = new Map(
    matchCorpus(subjectText, flattened, thresholds.narrativeWithImage, {
      excludeMint: subject.mint,
    }).map((match) => [match.candidate.mint, match]),
  );

  const priors: PriorRun[] = [];
  for (const coin of coins) {
    if (coin.mint === subject.mint) continue;

    const distance = hammingDistance(subjectPhash, coin.phash);
    const imageMatches = distance !== null && distance <= thresholds.phash.maxHamming;
    const textMatch = strict.get(coin.mint);

    if (textMatch === undefined && !imageMatches) continue;

    const matchedOn: NarrativeMatch[] = [...(textMatch ?? loose.get(coin.mint))?.matchedOn ?? []];
    if (imageMatches && !matchedOn.includes("image")) matchedOn.push("image");

    // A hash agreeing at distance d out of 64 bits, expressed on the same 0-1
    // scale as text similarity so the two can be compared and sorted together.
    // At the 10-bit bar this is 0.84, which is deliberately below a strong text
    // match: an identical picture is good evidence, not proof of identity.
    const imageSimilarity = imageMatches ? 1 - (distance as number) / 64 : 0;

    priors.push(
      toPriorRun(coin, Math.max(textMatch?.similarity ?? 0, imageSimilarity), matchedOn, distance, thresholds),
    );
  }

  priors.sort((a, b) => b.similarity - a.similarity || a.mint.localeCompare(b.mint));

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

function toPriorRun(
  coin: StoredCoin,
  similarity: number,
  matchedOn: NarrativeMatch[],
  imageDistance: number | null,
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
    similarity,
    matchedOn,
    imageDistance,
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
