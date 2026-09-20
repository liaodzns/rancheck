/**
 * One pass over the page.
 *
 * The orchestration, and nothing else: find the cards, read each one, assemble,
 * dedupe, and report how well it went. Every DOM assumption lives in
 * `selectors.ts` and every value conversion in `parse.ts`, so this file should
 * stay readable after a redesign that rewrites both.
 *
 * It is deliberately synchronous and pure with respect to the page — it reads,
 * and never writes. Badges are painted by the overlay layer against a separate
 * fixed-position tree, because React deletes anything injected into its own and
 * changing a row's height breaks the virtualiser's measurements.
 */
import type { PairObservation } from "../shared/types.js";
import {
  ExtractionTally,
  dedupeByMint,
  diagnose,
  toObservation,
  type Diagnosis,
  type ExtractionReport,
} from "./observation.js";
import { columnOf, findCards, readCard } from "./selectors.js";

export interface ScrapeResult {
  /** One per distinct mint on screen, most complete sighting per mint. */
  observations: PairObservation[];
  report: ExtractionReport;
  diagnosis: Diagnosis;
}

export interface ScrapeOptions {
  /** Wall clock for this pass. Injected so tests are deterministic. */
  now?: number;
  /** Resolves relative image sources. Defaults to the document's own URL. */
  baseUrl?: string;
  /**
   * Restrict to cards intersecting the viewport.
   *
   * The expensive work downstream — hashing images, running corpus lookups —
   * is only worth doing for rows a person can actually see. Left undefined in
   * tests and in the reconcile pass, where there is no viewport to speak of.
   */
  isVisible?: (card: Element) => boolean;
}

/**
 * Scrape `root` once.
 *
 * Never throws on a bad row. A redesign shows up as nulls and a falling
 * extraction rate, which `diagnosis` names; it must not show up as an exception
 * that kills the observer loop and takes the whole extension down silently.
 */
export function scrape(root: ParentNode, options: ScrapeOptions = {}): ScrapeResult {
  const now = options.now ?? Date.now();
  // Duck-typed rather than `instanceof Document`. A content script and a test
  // hold different realms — jsdom's `Element` is not the global one — and an
  // instanceof against the wrong realm throws or silently reports false. The
  // owning document is also the right answer for a fragment or a subtree root.
  const ownerDocument = (root as { ownerDocument?: Document | null }).ownerDocument ?? null;
  const baseUrl = options.baseUrl ?? ownerDocument?.URL ?? (root as Document).URL ?? undefined;

  const tally = new ExtractionTally();
  const observations: PairObservation[] = [];

  for (const card of findCards(root)) {
    if (options.isVisible !== undefined && !options.isVisible(card)) continue;

    let result;
    try {
      result = toObservation(readCard(card), columnOf(card), now, baseUrl);
    } catch {
      // A single malformed card must not cost us the other thirty-nine.
      result = { observation: null, rejected: "no-mint" as const };
    }

    tally.record(result);
    if (result.observation !== null) observations.push(result.observation);
  }

  const report = tally.report();
  return {
    observations: dedupeByMint(observations),
    report,
    diagnosis: diagnose(report),
  };
}
