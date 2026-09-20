/**
 * The type contract.
 *
 * Shapes are carried over from argus `packages/shared/src/events.ts` so the
 * narrative port in `worker/match.ts` compiles unmodified. Two deliberate
 * departures from argus:
 *
 * Zod is gone. argus validates at process boundaries because events cross a
 * Redis bus written by another process. Nothing here crosses a boundary we do
 * not own: the scraper produces observations in-process and hands them to a
 * worker in the same extension. The one place untrusted JSON does arrive is the
 * phase 5 importer, which validates at its own edge rather than making every
 * consumer carry a runtime schema. Paying ~12KB of bundle for a guarantee we do
 * not need is the wrong trade in an extension.
 *
 * Only the fields matching actually reads are carried. The argus shapes have
 * ~20 more that belong to a trading pipeline this project is not building.
 */

/** Base58 Solana address. The alphabet excludes 0, O, I and l. */
export type Address = string;

/** Milliseconds since epoch. Wall clock — see `PairObservation.seenAt`. */
export type Timestamp = number;

/**
 * Which of the corpus entry's fields was recognisable in the subject.
 *
 * `metadata` means an identical metadata URI, so the two are byte-identical.
 * `image` and `socials` are argus values kept for shape compatibility; `image`
 * arrives in phase 4 with the phash band index, `socials` may never.
 */
export type NarrativeMatch = "name" | "symbol" | "metadata" | "image" | "socials";

/**
 * A token launch, as the phase 5 importer and the argus fixture supply it.
 *
 * `fixtures/launches-2026-09-17.json` predates argus's own launch source and
 * carries exactly these four fields. That is not a gap — they are the fields
 * matching needs, and everything else in argus's `MintEvent` exists to serve
 * scoring and monitoring, which are explicit non-goals here.
 */
export interface MintEvent {
  mint: Address;
  name: string;
  symbol: string;
  /** Off-chain metadata URI. Two launches sharing one are byte-identical. */
  uri: string;
}

/**
 * What we know about a token, independent of any one sighting.
 *
 * `imagePhash` is the field argus declared and never filled
 * (`enrich.ts`: `imagePhash: null, // computed at step 9`). Phase 4 fills it.
 */
export interface TokenMeta {
  mint: Address;
  name: string;
  symbol: string;
  imageUrl: string | null;
  /** Perceptual hash, 16 hex characters. Null until the image has been fetched. */
  imagePhash: string | null;
  createdAt: Timestamp;
}

/**
 * One sighting of one pair on one Axiom screen.
 *
 * Everything but `mint` is genuinely optional. A scraper that throws because a
 * redesign moved the volume column is worse than one that returns nulls, and
 * the matcher already tolerates missing text — that is what `minLength` is for.
 *
 * `seenAt` is wall clock and means "when this browser rendered it", not when
 * the launch happened. Nothing may treat it as chain time.
 */
export interface PairObservation {
  /** Required; drop the row without it. Parsed from the `/meme/<mint>` href. */
  mint: Address;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  /** If ever exposed by the DOM; enables the identical-URI shortcut. */
  metadataUri: string | null;
  marketCapUsd: number | null;
  volumeUsd: number | null;
  ageSeconds: number | null;
  seenAt: Timestamp;
  source: ObservationSource;
}

/**
 * Which surface a sighting came from.
 *
 * The spec's original union was `new-pairs | trending | detail | other`, written
 * before anyone had looked at Pulse. The captured screen shows three columns —
 * New Pairs, Final Stretch and Migrated — so `final-stretch` and `migrated` are
 * added and `trending` is kept for Axiom's other surfaces.
 *
 * This is not cosmetic. Phase 4's "did it run" rule is peak market cap over a
 * floor **or** the coin having been seen in a migrated context, and `migrated`
 * is where that second clause comes from: a coin in that column has completed
 * its bonding curve, which is the one run signal that does not depend on having
 * had the tab open at the right moment. Without a value for it the classifier
 * can only ever see what your screen happened to catch.
 *
 * `final-stretch` is not a run on its own — it is a coin close to migrating and
 * it may still die there — but it is worth distinguishing from `new-pairs`
 * rather than flattening both into one bucket we cannot separate later.
 */
export type ObservationSource =
  | "new-pairs"
  | "final-stretch"
  | "migrated"
  | "trending"
  | "detail"
  | "other";
