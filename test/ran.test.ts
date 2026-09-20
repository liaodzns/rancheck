/**
 * The run classifier and the merge rules.
 *
 * These decide what the badge's primary number means, so the tests are as much
 * about what must *not* happen — a peak being forgotten, a null lowering a
 * reading, migration being un-observed — as about what must.
 */
import { describe, expect, it } from "vitest";
import { didRun, isMigratedSighting, mergeSighting, ranEvidence } from "../src/worker/ran.js";
import { normaliseText } from "../src/worker/index-store.js";
import { THRESHOLDS } from "../src/shared/config.js";
import type { PairObservation, StoredCoin } from "../src/shared/types.js";

const MINT = "AtbSvZug8WZM4AuDb9MYryXbr3okXrk8BZGGCwvqpump";
const T0 = 1_758_300_000_000;

const observe = (overrides: Partial<PairObservation> = {}): PairObservation => ({
  mint: MINT,
  name: "The Rogue AI",
  symbol: "RogueGPT",
  imageUrl: "https://cdn.example/a.webp",
  metadataUri: null,
  marketCapUsd: 3050,
  volumeUsd: 66,
  ageSeconds: 14,
  seenAt: T0,
  source: "new-pairs",
  ...overrides,
});

const norm = (o: PairObservation) => normaliseText(o.name, o.symbol, THRESHOLDS.corpus);
const merge = (existing: StoredCoin | null, o: PairObservation) =>
  mergeSighting(existing, o, norm(o), THRESHOLDS.ran);

describe("didRun", () => {
  it("counts a coin over the market-cap floor", () => {
    expect(didRun({ peakMcUsd: 100_000, sawMigrated: false }, THRESHOLDS.ran)).toBe(true);
    expect(didRun({ peakMcUsd: 99_999, sawMigrated: false }, THRESHOLDS.ran)).toBe(false);
  });

  it("counts a migrated coin regardless of what market cap was observed", () => {
    // The one run signal that survives not having been watching: migration is a
    // fact about the coin's history, not about the moment you looked.
    expect(didRun({ peakMcUsd: null, sawMigrated: true }, THRESHOLDS.ran)).toBe(true);
    expect(didRun({ peakMcUsd: 12, sawMigrated: true }, THRESHOLDS.ran)).toBe(true);
  });

  it("does not count a coin with no market cap ever observed", () => {
    // Absence of evidence. The corpus undercounts runs in one direction and
    // this is where that happens — deliberately, rather than by guessing up.
    expect(didRun({ peakMcUsd: null, sawMigrated: false }, THRESHOLDS.ran)).toBe(false);
  });

  it("re-derives from a moved floor without a migration", () => {
    const coin = { peakMcUsd: 50_000, sawMigrated: false };
    expect(didRun(coin, { minPeakMcUsd: 100_000 })).toBe(false);
    expect(didRun(coin, { minPeakMcUsd: 10_000 })).toBe(true);
  });
});

describe("isMigratedSighting", () => {
  it("counts only the Migrated column", () => {
    expect(isMigratedSighting("migrated")).toBe(true);
  });

  it("does not count Final Stretch", () => {
    // A coin there is close to migrating and may still die there. Counting
    // near-misses would inflate the number the whole product rests on.
    expect(isMigratedSighting("final-stretch")).toBe(false);
    expect(isMigratedSighting("new-pairs")).toBe(false);
  });
});

describe("ranEvidence", () => {
  it("names migration ahead of market cap", () => {
    expect(ranEvidence({ peakMcUsd: 500_000, sawMigrated: true }, THRESHOLDS.ran)).toBe("migrated");
    expect(ranEvidence({ peakMcUsd: 500_000, sawMigrated: false }, THRESHOLDS.ran)).toBe("market-cap");
    expect(ranEvidence({ peakMcUsd: 5, sawMigrated: false }, THRESHOLDS.ran)).toBe("none");
  });
});

describe("mergeSighting", () => {
  it("creates a coin from a first sighting", () => {
    const coin = merge(null, observe());
    expect(coin.mint).toBe(MINT);
    expect(coin.normName).toBe("rogueai");
    expect(coin.sightings).toBe(1);
    expect(coin.firstSeen).toBe(T0);
    expect(coin.ran).toBe(false);
  });

  it("keeps the highest market cap ever seen, not the latest", () => {
    // The rule the whole classifier depends on. A coin that touched $200k and
    // fell back to $4k ran, and storing the latest reading forgets that
    // silently.
    let coin = merge(null, observe({ marketCapUsd: 200_000 }));
    coin = merge(coin, observe({ marketCapUsd: 4_000, seenAt: T0 + 60_000 }));
    expect(coin.peakMcUsd).toBe(200_000);
    expect(coin.ran).toBe(true);
  });

  it("never lets a null reading lower a peak", () => {
    // A row whose market cap column failed to parse is an absence of evidence,
    // not evidence of zero.
    let coin = merge(null, observe({ marketCapUsd: 200_000 }));
    coin = merge(coin, observe({ marketCapUsd: null, volumeUsd: null }));
    expect(coin.peakMcUsd).toBe(200_000);
    expect(coin.peakVolUsd).toBe(66);
  });

  it("latches sawMigrated and never clears it", () => {
    let coin = merge(null, observe({ source: "migrated" }));
    expect(coin.sawMigrated).toBe(true);
    coin = merge(coin, observe({ source: "new-pairs" }));
    expect(coin.sawMigrated).toBe(true);
    expect(coin.ran).toBe(true);
  });

  it("fills a missing name from a later sighting", () => {
    let coin = merge(null, observe({ name: null }));
    expect(coin.normName).toBe("");
    coin = merge(coin, observe({ name: "The Rogue AI" }));
    expect(coin.name).toBe("The Rogue AI");
    expect(coin.normName).toBe("rogueai");
  });

  it("does not overwrite a name it already has", () => {
    // Axiom truncates long names in some columns, so a later sighting is as
    // likely to be worse as better. Churning would make the popover unstable.
    let coin = merge(null, observe({ name: "The Boring Company" }));
    coin = merge(coin, observe({ name: "The Boring Compan…" }));
    expect(coin.name).toBe("The Boring Company");
  });

  it("widens the observed window in both directions", () => {
    let coin = merge(null, observe({ seenAt: T0 }));
    coin = merge(coin, observe({ seenAt: T0 - 5_000 }));
    coin = merge(coin, observe({ seenAt: T0 + 5_000 }));
    expect(coin.firstSeen).toBe(T0 - 5_000);
    expect(coin.lastSeen).toBe(T0 + 5_000);
    expect(coin.sightings).toBe(3);
  });

  it("does not mutate what it was given", () => {
    const first = merge(null, observe());
    const snapshot = { ...first };
    merge(first, observe({ marketCapUsd: 900_000 }));
    expect(first).toEqual(snapshot);
  });
});
