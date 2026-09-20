/**
 * Turning a scraped row into a `PairObservation`, and watching whether that is
 * still working.
 *
 * Two jobs, together because they are the same loop. Assembly is deliberately
 * permissive: a row missing its volume column is still worth storing, because
 * the mint and the name are what matching needs. The one hard requirement is a
 * full mint, without which the row cannot be keyed and is dropped.
 *
 * Permissiveness has a cost, though, and the tally is what pays it. A scraper
 * that returns nulls rather than throwing survives a redesign — and says
 * nothing about it. A redesign does not look like an error; it looks like every
 * name suddenly being null while the mints keep working perfectly. That is the
 * specific shape `diagnose()` exists to catch.
 */
import type { ObservationSource, PairObservation } from "../shared/types.js";
import {
  cleanImageUrl,
  cleanText,
  isFullMint,
  parseAgeSeconds,
  parseCompactNumber,
  parseMintFromHref,
  truncatedMintMatches,
} from "./parse.js";

/**
 * One row's worth of raw strings, exactly as the DOM gave them up.
 *
 * This is the seam between the fragile half of the scraper and the stable one.
 * `selectors.ts` produces these and is the only thing that knows what an Axiom
 * card looks like; everything downstream consumes this shape and does not care.
 * When a redesign lands, that is the file that changes and this one does not.
 */
export interface RawRow {
  /** The `/meme/<mint>` href. The primary key's only trustworthy source. */
  mintHref: string | null;
  /** Axiom's truncated footer mint, `BQkG...GUrK`. A cross-check, never a key. */
  mintText: string | null;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  metadataUri: string | null;
  marketCap: string | null;
  volume: string | null;
  age: string | null;
}

export type { ObservationSource };

/** Why a row produced no observation. Counted, so silent loss is impossible. */
export type RejectReason = "no-mint" | "mint-mismatch";

export interface RowResult {
  observation: PairObservation | null;
  rejected: RejectReason | null;
}

/**
 * Build an observation from a raw row.
 *
 * `baseUrl` resolves relative image sources and defaults to Axiom's origin, so
 * this is callable from a test with no document in scope.
 */
export function toObservation(
  raw: RawRow,
  source: ObservationSource,
  seenAt: number,
  baseUrl?: string | undefined,
): RowResult {
  const mint = parseMintFromHref(raw.mintHref);
  if (mint === null || !isFullMint(mint)) {
    return { observation: null, rejected: "no-mint" };
  }

  // Virtualised lists recycle nodes, so an anchor and a footer can briefly
  // belong to different coins mid-update. Storing that mismatch would attribute
  // one coin's market cap to another, so the row is dropped and counted.
  if (!truncatedMintMatches(raw.mintText, mint)) {
    return { observation: null, rejected: "mint-mismatch" };
  }

  return {
    observation: {
      mint,
      name: cleanText(raw.name),
      symbol: cleanText(raw.symbol),
      imageUrl: cleanImageUrl(raw.imageUrl, baseUrl),
      metadataUri: cleanText(raw.metadataUri),
      marketCapUsd: parseCompactNumber(raw.marketCap),
      volumeUsd: parseCompactNumber(raw.volume),
      ageSeconds: parseAgeSeconds(raw.age),
      seenAt,
      source,
    },
    rejected: null,
  };
}

/**
 * Collapse a pass's observations to one per mint.
 *
 * The same coin is genuinely on screen more than once: a pair sitting in Final
 * Stretch also appears in New Pairs, with identical numbers, and both columns
 * are scraped in the same pass. Without this, every such coin is written to the
 * corpus twice per tick and its sighting count — which phase 3 uses to decide
 * how well observed a coin is — inflates on nothing but layout.
 *
 * The survivor is the most complete row rather than the first, since which
 * column renders more fields is not something the caller should have to know.
 * Ties go to the earlier entry, which keeps column order meaningful.
 */
export function dedupeByMint(observations: readonly PairObservation[]): PairObservation[] {
  const best = new Map<string, PairObservation>();

  for (const observation of observations) {
    const existing = best.get(observation.mint);
    if (existing === undefined || completeness(observation) > completeness(existing)) {
      best.set(observation.mint, observation);
    }
  }

  return [...best.values()];
}

/** How many optional fields a row actually resolved. */
function completeness(observation: PairObservation): number {
  const fields = [
    observation.name,
    observation.symbol,
    observation.imageUrl,
    observation.metadataUri,
    observation.marketCapUsd,
    observation.volumeUsd,
    observation.ageSeconds,
  ];
  return fields.filter((field) => field !== null).length;
}

/** The fields worth tracking an extraction rate for. */
export const TRACKED_FIELDS = [
  "name",
  "symbol",
  "imageUrl",
  "metadataUri",
  "marketCapUsd",
  "volumeUsd",
  "ageSeconds",
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

export interface ExtractionReport {
  /** Rows the selectors produced, including those that yielded no observation. */
  rows: number;
  /** Rows that produced an observation, so had a usable mint. */
  kept: number;
  rejected: Record<RejectReason, number>;
  /** Per field, the share of kept rows where it resolved. 0–1. */
  rates: Record<TrackedField, number>;
}

/**
 * Running per-field extraction rates.
 *
 * Cheap on purpose — a handful of integer increments per row, on a feed doing
 * 31 launches a minute with the reconcile pass running on top. Anything that
 * allocated per row would be paid for out of Axiom's own rendering budget, and
 * an extension that makes the feed janky does not get used however good its
 * telemetry is.
 */
export class ExtractionTally {
  private rows = 0;
  private kept = 0;
  private readonly rejects: Record<RejectReason, number> = {
    "no-mint": 0,
    "mint-mismatch": 0,
  };
  private readonly hits: Record<TrackedField, number> = {
    name: 0,
    symbol: 0,
    imageUrl: 0,
    metadataUri: 0,
    marketCapUsd: 0,
    volumeUsd: 0,
    ageSeconds: 0,
  };

  record(result: RowResult): void {
    this.rows += 1;

    if (result.observation === null) {
      if (result.rejected !== null) this.rejects[result.rejected] += 1;
      return;
    }

    this.kept += 1;
    const observation = result.observation;
    for (const field of TRACKED_FIELDS) {
      if (observation[field] !== null) this.hits[field] += 1;
    }
  }

  report(): ExtractionReport {
    const rates = {} as Record<TrackedField, number>;
    for (const field of TRACKED_FIELDS) {
      rates[field] = this.kept === 0 ? 0 : this.hits[field] / this.kept;
    }
    return {
      rows: this.rows,
      kept: this.kept,
      rejected: { ...this.rejects },
      rates,
    };
  }

  reset(): void {
    this.rows = 0;
    this.kept = 0;
    for (const reason of Object.keys(this.rejects) as RejectReason[]) this.rejects[reason] = 0;
    for (const field of TRACKED_FIELDS) this.hits[field] = 0;
  }
}

/**
 * How healthy a pass looks, and what specifically is wrong if it does not.
 *
 * `metadataUri` is excluded from the redesign check because Axiom may simply
 * never expose it. A field that has always been 0% is not a regression, and
 * warning about it every pass would train the warning to be ignored — which
 * costs us the one signal that matters when name extraction really does drop.
 */
export type Health = "ok" | "cold" | "mints-failing" | "fields-failing";

export interface Diagnosis {
  health: Health;
  /** Fields below the floor, when `health` is `fields-failing`. */
  failing: TrackedField[];
  message: string;
}

const REDESIGN_CHECKED: readonly TrackedField[] = TRACKED_FIELDS.filter(
  (field) => field !== "metadataUri",
);

/**
 * Judge a report.
 *
 * `minRows` exists because a rate over three rows is noise. The feed renders
 * dozens at a time, so waiting for a real sample costs nothing and stops the
 * extension from crying redesign every time a column is mid-render.
 */
export function diagnose(
  report: ExtractionReport,
  options: { minRows?: number; floor?: number } = {},
): Diagnosis {
  const minRows = options.minRows ?? 20;
  // A field that resolves on fewer than half of rows is not "sometimes absent",
  // it is broken. Real absences — a brand-new pair with no volume yet — do not
  // reach anywhere near this rate.
  const floor = options.floor ?? 0.5;

  if (report.rows < minRows) {
    return {
      health: "cold",
      failing: [],
      message: `only ${report.rows} rows seen; need ${minRows} before judging extraction`,
    };
  }

  // Mints first: if they are gone, every other rate is computed over nothing
  // and reporting a name failure would point at the wrong file.
  if (report.kept === 0) {
    return {
      health: "mints-failing",
      failing: [],
      message: `no /meme/ link resolved on any of ${report.rows} rows; the row anchor has moved`,
    };
  }

  const failing = REDESIGN_CHECKED.filter((field) => report.rates[field] < floor);
  if (failing.length > 0) {
    const detail = failing
      .map((field) => `${field} ${(report.rates[field] * 100).toFixed(0)}%`)
      .join(", ");
    return {
      health: "fields-failing",
      failing: [...failing],
      message: `mints resolve on ${report.kept}/${report.rows} rows but ${detail} — likely a redesign`,
    };
  }

  return {
    health: "ok",
    failing: [],
    message: `${report.kept}/${report.rows} rows kept, all tracked fields above ${(floor * 100).toFixed(0)}%`,
  };
}
