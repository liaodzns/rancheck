/**
 * Did it run?
 *
 * This classifier decides whether the whole product is useful or noise, and it
 * is worth being clear about why. Matching is bimodal: a member of a real wave
 * matches around two dozen other deployments, almost all of which died within
 * minutes. "This ticker has been deployed 47 times" is a fact nobody needs and
 * cannot act on. "This ticker has run 3 times out of 47" is the trade.
 *
 * So the badge's primary number counts only entries that cleared a bar, and
 * this file is the bar.
 *
 * ---------------------------------------------------------------------------
 * The honest limitation, which the UI must never paper over.
 *
 * You only observe what was on your screen. A coin that ran at 3am while the
 * laptop was shut is stored with whatever peak was last seen — which may be
 * nothing at all. **The corpus undercounts runs, systematically and in one
 * direction.** Every number this file produces is a floor, not a count.
 *
 * That is why `sawMigrated` exists alongside the market-cap test. A coin in
 * Axiom's Migrated column completed its bonding curve, and that is a fact about
 * the coin's whole history rather than about the moment you happened to look.
 * It is the one run signal that survives not having been watching, so it is
 * recorded as an observation in its own right and is never overwritten by a
 * later re-derivation.
 * ---------------------------------------------------------------------------
 */
import type { ObservationSource, PairObservation, StoredCoin } from "../shared/types.js";
import type { RanThresholds } from "../shared/config.js";

/** Sources that establish a coin got past its bonding curve. */
const MIGRATED_SOURCES: ReadonlySet<ObservationSource> = new Set<ObservationSource>(["migrated"]);

/**
 * Whether a sighting is evidence of migration.
 *
 * `final-stretch` deliberately does not count. A coin there is close to
 * migrating and may still die there, and counting near-misses as runs would
 * inflate the number the whole product rests on.
 */
export function isMigratedSighting(source: ObservationSource): boolean {
  return MIGRATED_SOURCES.has(source);
}

/**
 * Decide whether a coin has run, from what has been observed of it.
 *
 * Two independent routes, either sufficient:
 *
 * - **Peak market cap over the floor.** What you saw with your own feed.
 * - **Seen migrated.** What the coin did whether or not you saw it.
 *
 * Pure, and takes its threshold as an argument, so moving the floor re-derives
 * every stored coin's verdict without a migration.
 */
export function didRun(
  coin: Pick<StoredCoin, "peakMcUsd" | "sawMigrated">,
  thresholds: RanThresholds,
): boolean {
  if (coin.sawMigrated) return true;
  return coin.peakMcUsd !== null && coin.peakMcUsd >= thresholds.minPeakMcUsd;
}

/** Why a coin counts as having run. For the popover, which must not assert more than it knows. */
export type RanEvidence = "migrated" | "market-cap" | "none";

export function ranEvidence(
  coin: Pick<StoredCoin, "peakMcUsd" | "sawMigrated">,
  thresholds: RanThresholds,
): RanEvidence {
  if (coin.sawMigrated) return "migrated";
  if (coin.peakMcUsd !== null && coin.peakMcUsd >= thresholds.minPeakMcUsd) return "market-cap";
  return "none";
}

/**
 * Fold a new sighting into what is already stored.
 *
 * Returns a new record; does not mutate. The merge rules are the whole of the
 * corpus's write semantics and each one is deliberate:
 *
 * - **Peaks take the maximum, never the latest.** A coin that touched $200k and
 *   fell back to $4k ran. Overwriting with the latest reading would forget
 *   that, and the forgetting would be silent.
 * - **A null reading never lowers a peak.** A row whose market cap column
 *   failed to parse is an absence of evidence, not evidence of zero.
 * - **Text fields fill gaps but do not overwrite.** The first good name is kept.
 *   Axiom truncates long names in some columns, so a later sighting is as
 *   likely to be worse as better, and churning the stored name would make the
 *   popover unstable for no gain.
 * - **`sawMigrated` is sticky.** It latches true and never returns to false.
 */
export function mergeSighting(
  existing: StoredCoin | null,
  observation: PairObservation,
  normalised: { normName: string; normSymbol: string; trigrams: string[] },
  thresholds: RanThresholds,
): StoredCoin {
  const migratedNow = isMigratedSighting(observation.source);

  if (existing === null) {
    const fresh: StoredCoin = {
      mint: observation.mint,
      name: observation.name,
      symbol: observation.symbol,
      normName: normalised.normName,
      normSymbol: normalised.normSymbol,
      trigrams: normalised.trigrams,
      imageUrl: observation.imageUrl,
      phash: null,
      phashState: null,
      firstSeen: observation.seenAt,
      lastSeen: observation.seenAt,
      peakMcUsd: observation.marketCapUsd,
      peakVolUsd: observation.volumeUsd,
      ran: false,
      sawMigrated: migratedNow,
      sightings: 1,
    };
    return { ...fresh, ran: didRun(fresh, thresholds) };
  }

  const merged: StoredCoin = {
    ...existing,
    name: existing.name ?? observation.name,
    symbol: existing.symbol ?? observation.symbol,
    // Re-derive the normalised forms only when the text they came from was
    // filled in by this sighting, so a stored key never drifts from its source.
    normName: existing.name === null && observation.name !== null ? normalised.normName : existing.normName,
    normSymbol:
      existing.symbol === null && observation.symbol !== null
        ? normalised.normSymbol
        : existing.normSymbol,
    trigrams:
      (existing.name === null && observation.name !== null) ||
      (existing.symbol === null && observation.symbol !== null)
        ? normalised.trigrams
        : existing.trigrams,
    imageUrl: existing.imageUrl ?? observation.imageUrl,
    firstSeen: Math.min(existing.firstSeen, observation.seenAt),
    lastSeen: Math.max(existing.lastSeen, observation.seenAt),
    peakMcUsd: higher(existing.peakMcUsd, observation.marketCapUsd),
    peakVolUsd: higher(existing.peakVolUsd, observation.volumeUsd),
    sawMigrated: existing.sawMigrated || migratedNow,
    sightings: existing.sightings + 1,
  };

  return { ...merged, ran: didRun(merged, thresholds) };
}

/** The larger of two readings, treating null as "no reading" rather than zero. */
function higher(stored: number | null, incoming: number | null): number | null {
  if (incoming === null) return stored;
  if (stored === null) return incoming;
  return Math.max(stored, incoming);
}
