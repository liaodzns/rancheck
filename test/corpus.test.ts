/**
 * The corpus, against a real IndexedDB implementation.
 *
 * `fake-indexeddb` is the actual W3C algorithm, not a stub, so transactions,
 * index maintenance and key ranges all behave as they will in Chrome. Anything
 * that passes here for the wrong reason would have to be wrong in the spec too.
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbCorpus,
  closeCorpus,
  recordObservations,
  runRetention,
} from "../src/worker/corpus.js";
import { lookup } from "../src/worker/lookup.js";
import { mergeCandidates, normaliseText, phashBands, trigramsOf } from "../src/worker/index-store.js";
import { recordPhashes, pendingImageWork } from "../src/worker/corpus.js";
import { THRESHOLDS } from "../src/shared/config.js";
import type { PairObservation } from "../src/shared/types.js";

const T0 = 1_758_300_000_000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Distinct, valid-looking base58 mints.
 *
 * Padded with `A` rather than a digit. Padding with `1` collides — `1` and
 * `11` both pad to `"11"` — which is how the first draft of this file quietly
 * asked the corpus to store nine duplicate mints and then failed the assertion
 * the corpus had got right.
 */
const mint = (n: number): string => `${String(n).padStart(3, "A")}TGF97nuz88QXET6KjnC6JK3ZuS27FJvPtTv`;

const observe = (overrides: Partial<PairObservation> = {}): PairObservation => ({
  mint: mint(1),
  name: "Thursday Arena",
  symbol: "THURSDAY",
  imageUrl: null,
  metadataUri: null,
  marketCapUsd: 3_000,
  volumeUsd: 100,
  ageSeconds: 30,
  seenAt: T0,
  source: "new-pairs",
  ...overrides,
});

beforeEach(() => {
  // A fresh database per test. The corpus caches its connection across calls by
  // design, so it has to be told the old one is gone.
  closeCorpus();
  globalThis.indexedDB = new IDBFactory();
});

describe("recording", () => {
  it("stores a coin and sets the corpus start time", async () => {
    await recordObservations([observe()], THRESHOLDS, T0);
    const corpus = new IndexedDbCorpus();
    const [coin] = await corpus.getMany([mint(1)]);

    expect(coin!.mint).toBe(mint(1));
    expect(coin!.normName).toBe("thursdayarena");
    expect(coin!.sightings).toBe(1);

    const meta = await corpus.meta();
    expect(meta.startedAt).toBe(T0);
    expect(meta.coinCount).toBe(1);
  });

  it("never moves the corpus start time once set", async () => {
    // The honest-zero depends on this being when watching began, not when the
    // last write happened.
    await recordObservations([observe()], THRESHOLDS, T0);
    await recordObservations([observe({ mint: mint(2) })], THRESHOLDS, T0 + 10 * DAY);
    expect((await new IndexedDbCorpus().meta()).startedAt).toBe(T0);
  });

  it("counts a second sighting of the same coin as one coin", async () => {
    await recordObservations([observe()], THRESHOLDS, T0);
    await recordObservations([observe({ seenAt: T0 + 1000 })], THRESHOLDS, T0 + 1000);

    const corpus = new IndexedDbCorpus();
    const [coin] = await corpus.getMany([mint(1)]);
    expect(coin!.sightings).toBe(2);
    expect((await corpus.meta()).coinCount).toBe(1);
  });

  it("writes a whole pass in one transaction", async () => {
    const pass = Array.from({ length: 30 }, (_, i) =>
      observe({ mint: mint(i + 1), name: `Coin ${i}`, symbol: `C${i}` }),
    );
    const written = await recordObservations(pass, THRESHOLDS, T0);
    expect(written).toHaveLength(30);
    expect((await new IndexedDbCorpus().meta()).coinCount).toBe(30);
  });

  it("is a no-op on an empty pass", async () => {
    expect(await recordObservations([], THRESHOLDS, T0)).toEqual([]);
  });

  it("collapses a mint repeated within a single pass", async () => {
    // The content script dedupes by mint before sending, but the corpus must
    // not depend on that: a pass carrying the same coin twice has to produce
    // one coin with two sightings, not two rows or an inflated count.
    await recordObservations([observe(), observe({ seenAt: T0 + 5 })], THRESHOLDS, T0);
    const corpus = new IndexedDbCorpus();
    expect(await corpus.getMany([mint(1)])).toHaveLength(1);
    expect((await corpus.meta()).coinCount).toBe(1);
  });
});

describe("candidate generation", () => {
  it("retrieves a prior deployment by exact normalised name", async () => {
    await recordObservations(
      [
        observe({ mint: mint(1), name: "Thursday Arena", symbol: "THURSDAY" }),
        observe({ mint: mint(2), name: "Chaotic Rocket", symbol: "ROCKET" }),
      ],
      THRESHOLDS,
      T0,
    );

    const { coins } = await new IndexedDbCorpus().candidatesFor({
      mint: mint(9),
      name: "THURSDAY ARENA",
      symbol: "ARENA",
    });
    expect(coins.map((c) => c.mint)).toContain(mint(1));
  });

  it("retrieves across fields, name against ticker", async () => {
    // The CUPCAKE case, through the index: a clone can carry the parent's name
    // in its ticker field, so the index has to be queried both ways.
    await recordObservations(
      [observe({ mint: mint(1), name: "cupcake", symbol: "ZZZZ" })],
      THRESHOLDS,
      T0,
    );
    const { coins } = await new IndexedDbCorpus().candidatesFor({
      mint: mint(9),
      name: "Something Else",
      symbol: "CUPCAKE",
    });
    expect(coins.map((c) => c.mint)).toContain(mint(1));
  });

  it("excludes the subject's own mint", async () => {
    await recordObservations([observe()], THRESHOLDS, T0);
    const { coins } = await new IndexedDbCorpus().candidatesFor({
      mint: mint(1),
      name: "Thursday Arena",
      symbol: "THURSDAY",
    });
    expect(coins.map((c) => c.mint)).not.toContain(mint(1));
  });

  it("does not retrieve every unnamed coin for an unnamed subject", async () => {
    // The blank-name failure, arriving through the index instead of the
    // matcher. An empty normalised key must never be used as a lookup.
    await recordObservations(
      [
        observe({ mint: mint(1), name: null, symbol: null }),
        observe({ mint: mint(2), name: null, symbol: null }),
      ],
      THRESHOLDS,
      T0,
    );
    const { coins } = await new IndexedDbCorpus().candidatesFor({
      mint: mint(9),
      name: null,
      symbol: null,
    });
    expect(coins).toEqual([]);
  });

  it("caps the candidate list and says so", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      observe({ mint: mint(i + 1), name: "Thursday Arena", symbol: "THURSDAY" }),
    );
    await recordObservations(many, THRESHOLDS, T0);

    const corpus = new IndexedDbCorpus({
      ...THRESHOLDS,
      candidates: { maxPerRow: 10 },
    });
    const { coins, capped } = await corpus.candidatesFor({
      mint: mint(99),
      name: "Thursday Arena",
      symbol: "THURSDAY",
    });
    expect(capped).toBe(true);
    expect(coins).toHaveLength(10);
  });
});

describe("retention", () => {
  it("drops a stale coin that never ran", async () => {
    await recordObservations([observe()], THRESHOLDS, T0);
    const removed = await runRetention(THRESHOLDS, T0 + 31 * DAY);
    expect(removed).toBe(1);
    expect(await new IndexedDbCorpus().getMany([mint(1)])).toEqual([]);
  });

  it("never drops a coin that ran, however old", async () => {
    // A coin that ran is the entire point of keeping a corpus, and the rarest
    // thing in it.
    await recordObservations([observe({ marketCapUsd: 500_000 })], THRESHOLDS, T0);
    expect(await runRetention(THRESHOLDS, T0 + 365 * DAY)).toBe(0);
    expect(await new IndexedDbCorpus().getMany([mint(1)])).toHaveLength(1);
  });

  it("keeps a coin that is merely recent", async () => {
    await recordObservations([observe()], THRESHOLDS, T0);
    expect(await runRetention(THRESHOLDS, T0 + 2 * DAY)).toBe(0);
  });

  it("decrements the coin count it removed", async () => {
    await recordObservations(
      [observe({ mint: mint(1) }), observe({ mint: mint(2), marketCapUsd: 500_000 })],
      THRESHOLDS,
      T0,
    );
    await runRetention(THRESHOLDS, T0 + 31 * DAY);
    expect((await new IndexedDbCorpus().meta()).coinCount).toBe(1);
  });
});

describe("lookup", () => {
  /** Old enough that counts are shown. */
  const MATURE = T0 + 10 * DAY;

  /**
   * Age gating is tested against an explicit threshold, not the ambient one.
   *
   * These assert a behaviour — a young corpus withholds its count — and that
   * behaviour must not change meaning when someone tunes the shipped value.
   * An earlier draft used `THRESHOLDS` and went red the moment the production
   * three days was temporarily dropped to a minute for manual testing, which
   * is the test being coupled to a number it is not about.
   */
  const AGE_GATE = { ...THRESHOLDS, corpus: { ...THRESHOLDS.corpus, minAgeMsForBadge: 3 * DAY } };

  it("counts runs and deployments separately", async () => {
    await recordObservations(
      [
        observe({ mint: mint(1), marketCapUsd: 500_000 }),
        observe({ mint: mint(2), marketCapUsd: 1_000 }),
        observe({ mint: mint(3), source: "migrated", marketCapUsd: 900 }),
      ],
      THRESHOLDS,
      T0,
    );

    const result = await lookup(
      { mint: mint(9), name: "Thursday Arena", symbol: "THURSDAY" },
      new IndexedDbCorpus(),
      THRESHOLDS,
      MATURE,
    );

    expect(result.totalCount).toBe(3);
    // One by market cap, one by migration. The dead one is a deployment, not a
    // run — which is the entire distinction the badge exists to draw.
    expect(result.ranCount).toBe(2);
  });

  it("withholds a count while the corpus is too young to interpret", async () => {
    // A 0 here would be read as "never been run" when it means "we started
    // watching on Tuesday". Opposite conclusions, same glyph.
    await recordObservations([observe()], THRESHOLDS, T0);
    const result = await lookup(
      { mint: mint(9), name: "Nothing Alike", symbol: "ZZZZ" },
      new IndexedDbCorpus(),
      AGE_GATE,
      T0 + 60_000,
    );
    expect(result.confident).toBe(false);
    expect(result.corpusAgeMs).toBe(60_000);
  });

  it("is confident once the corpus is old enough", async () => {
    await recordObservations([observe()], THRESHOLDS, T0);
    const result = await lookup(
      { mint: mint(9), name: "Thursday Arena", symbol: "THURSDAY" },
      new IndexedDbCorpus(),
      AGE_GATE,
      MATURE,
    );
    expect(result.confident).toBe(true);
  });

  it("reports an empty corpus as age zero, not as a confident zero", async () => {
    const result = await lookup(
      { mint: mint(9), name: "Thursday Arena", symbol: "THURSDAY" },
      new IndexedDbCorpus(),
      AGE_GATE,
      T0,
    );
    expect(result.totalCount).toBe(0);
    expect(result.corpusAgeMs).toBe(0);
    expect(result.confident).toBe(false);
  });

  it("carries evidence and matchedOn through to the popover", async () => {
    await recordObservations(
      [observe({ mint: mint(1), source: "migrated" })],
      THRESHOLDS,
      T0,
    );
    const result = await lookup(
      { mint: mint(9), name: "Thursday Arena", symbol: "THURSDAY" },
      new IndexedDbCorpus(),
      THRESHOLDS,
      MATURE,
    );
    const [prior] = result.priors;
    expect(prior!.evidence).toBe("migrated");
    expect(prior!.matchedOn.length).toBeGreaterThan(0);
    expect(prior!.similarity).toBe(1);
  });

  it("does not report an image match as a metadata match", async () => {
    // An identical image URL is a usable proxy for an identical token, but it
    // is not a metadata URI, and the popover must not claim it is.
    await recordObservations(
      [observe({ mint: mint(1), imageUrl: "https://cdn.example/same.webp" })],
      THRESHOLDS,
      T0,
    );
    const result = await lookup(
      { mint: mint(9), name: "Thursday Arena", symbol: "THURSDAY" },
      new IndexedDbCorpus(),
      THRESHOLDS,
      MATURE,
    );
    expect(result.priors[0]!.matchedOn).not.toContain("metadata");
  });
});

describe("index helpers", () => {
  it("builds deduplicated trigrams", () => {
    expect(trigramsOf("bananana", THRESHOLDS.corpus)).toEqual(["ban", "ana", "nan"]);
  });

  it("yields no trigrams for a string too short to compare", () => {
    // The minLength guard, in the index domain.
    expect(trigramsOf("ab", THRESHOLDS.corpus)).toEqual([]);
    expect(trigramsOf("", THRESHOLDS.corpus)).toEqual([]);
  });

  it("derives index keys from the frozen normalizer", () => {
    const keys = normaliseText("THURSDAY ARENA", "THURSDAY", THRESHOLDS.corpus);
    expect(keys.normName).toBe("thursdayarena");
    expect(keys.normSymbol).toBe("thursday");
    expect(keys.trigrams).toContain("thu");
  });

  it("splits a phash into position-prefixed bands", () => {
    // The prefix stops band 0 of one hash colliding with band 2 of another,
    // which would retrieve unrelated images as candidates.
    expect(phashBands("0123456789abcdef")).toEqual(["0:0123", "1:4567", "2:89ab", "3:cdef"]);
  });

  it("yields no bands for a missing or malformed hash", () => {
    // A coin whose image failed to fetch stays out of the index entirely rather
    // than being filed under a hash of nothing.
    expect(phashBands(null)).toEqual([]);
    expect(phashBands("nothex")).toEqual([]);
  });

  it("merges buckets, dedupes, and reports the cap", () => {
    const merged = mergeCandidates([["a", "b"], ["b", "c"]], { max: 10 });
    expect(merged.mints.sort()).toEqual(["a", "b", "c"]);
    expect(merged.capped).toBe(false);

    const capped = mergeCandidates([["a", "b", "c"]], { max: 2 });
    expect(capped.capped).toBe(true);
    expect(capped.mints).toHaveLength(2);
  });
});


describe("image matching end to end", () => {
  const MATURE = T0 + 10 * DAY;
  const AGE_GATE_OK = { ...THRESHOLDS, corpus: { ...THRESHOLDS.corpus, minAgeMsForBadge: 3 * DAY } };

  /** Two hashes 4 bits apart — inside the 10-bit bar. */
  const HASH_A = "0f0f0f0f0f0f0f0f";
  const HASH_NEAR = "0f0f0f0f0f0f0f00";
  /** Far outside it. */
  const HASH_FAR = "f0f0f0f0f0f0f0f0";

  it("finds a clone that renamed completely", async () => {
    // The case phase 4 exists for, and the one both text indexes are blind to
    // by construction: same picture, no shared text at all.
    await recordObservations(
      [observe({ mint: mint(1), name: "Thursday Arena", symbol: "THURSDAY" })],
      THRESHOLDS,
      T0,
    );
    await recordPhashes([{ mint: mint(1), phash: HASH_A, state: "ok" }]);

    await recordObservations(
      [observe({ mint: mint(2), name: "Completely Unrelated", symbol: "ZZZZ" })],
      THRESHOLDS,
      T0,
    );
    await recordPhashes([{ mint: mint(2), phash: HASH_NEAR, state: "ok" }]);

    const result = await lookup(
      { mint: mint(2), name: "Completely Unrelated", symbol: "ZZZZ" },
      new IndexedDbCorpus(),
      AGE_GATE_OK,
      MATURE,
    );

    expect(result.totalCount).toBe(1);
    expect(result.priors[0]!.mint).toBe(mint(1));
    expect(result.priors[0]!.matchedOn).toContain("image");
    expect(result.priors[0]!.imageDistance).toBe(4);
  });

  it("does not match on a distant image", async () => {
    await recordObservations(
      [observe({ mint: mint(1), name: "Thursday Arena", symbol: "THURSDAY" })],
      THRESHOLDS,
      T0,
    );
    await recordPhashes([{ mint: mint(1), phash: HASH_A, state: "ok" }]);
    await recordObservations(
      [observe({ mint: mint(2), name: "Completely Unrelated", symbol: "ZZZZ" })],
      THRESHOLDS,
      T0,
    );
    await recordPhashes([{ mint: mint(2), phash: HASH_FAR, state: "ok" }]);

    const result = await lookup(
      { mint: mint(2), name: "Completely Unrelated", symbol: "ZZZZ" },
      new IndexedDbCorpus(),
      AGE_GATE_OK,
      MATURE,
    );
    expect(result.totalCount).toBe(0);
  });

  it("reports both image and text when both agree", async () => {
    await recordObservations(
      [observe({ mint: mint(1), name: "Thursday Arena", symbol: "THURSDAY" })],
      THRESHOLDS,
      T0,
    );
    await recordPhashes([{ mint: mint(1), phash: HASH_A, state: "ok" }]);
    await recordObservations([observe({ mint: mint(2) })], THRESHOLDS, T0);
    await recordPhashes([{ mint: mint(2), phash: HASH_NEAR, state: "ok" }]);

    const result = await lookup(
      { mint: mint(2), name: "Thursday Arena", symbol: "THURSDAY" },
      new IndexedDbCorpus(),
      AGE_GATE_OK,
      MATURE,
    );
    expect(result.priors[0]!.matchedOn).toContain("name");
    expect(result.priors[0]!.matchedOn).toContain("image");
  });

  it("treats a missing hash as unknown, never as a mismatch", async () => {
    // A coin whose image could not be fetched must still match on its text.
    await recordObservations([observe({ mint: mint(1) })], THRESHOLDS, T0);
    await recordPhashes([{ mint: mint(1), phash: null, state: "unavailable" }]);
    await recordObservations([observe({ mint: mint(2) })], THRESHOLDS, T0);

    const result = await lookup(
      { mint: mint(2), name: "Thursday Arena", symbol: "THURSDAY" },
      new IndexedDbCorpus(),
      AGE_GATE_OK,
      MATURE,
    );
    expect(result.totalCount).toBe(1);
    expect(result.priors[0]!.imageDistance).toBeNull();
    expect(result.priors[0]!.matchedOn).not.toContain("image");
  });
});

describe("image work queue", () => {
  it("offers a coin that has an image and no verdict", async () => {
    await recordObservations(
      [observe({ imageUrl: "https://cdn.example/a.webp" })],
      THRESHOLDS,
      T0,
    );
    const work = await pendingImageWork([mint(1)], T0);
    expect(work).toEqual([{ mint: mint(1), imageUrl: "https://cdn.example/a.webp" }]);
  });

  it("never offers a coin again once hashed", async () => {
    await recordObservations(
      [observe({ imageUrl: "https://cdn.example/a.webp" })],
      THRESHOLDS,
      T0,
    );
    await recordPhashes([{ mint: mint(1), phash: "0f0f0f0f0f0f0f0f", state: "ok" }]);
    expect(await pendingImageWork([mint(1)], T0)).toEqual([]);
  });

  it("never retries a degenerate image", async () => {
    // A flat picture will be flat next time too. Retrying spends a fetch and a
    // decode to learn the same thing.
    await recordObservations(
      [observe({ imageUrl: "https://cdn.example/flat.webp" })],
      THRESHOLDS,
      T0,
    );
    await recordPhashes([{ mint: mint(1), phash: null, state: "degenerate" }]);
    expect(await pendingImageWork([mint(1)], T0 + 365 * DAY)).toEqual([]);
  });

  it("retries an unavailable image, but only after a delay", async () => {
    // A dead link or a timeout may not be permanent. One broken CDN must not
    // occupy the queue every pass in the meantime.
    await recordObservations(
      [observe({ imageUrl: "https://cdn.example/gone.webp" })],
      THRESHOLDS,
      T0,
    );
    await recordPhashes([{ mint: mint(1), phash: null, state: "unavailable" }]);
    expect(await pendingImageWork([mint(1)], T0)).toEqual([]);
    expect(await pendingImageWork([mint(1)], T0 + 7 * 60 * 60 * 1000)).toHaveLength(1);
  });

  it("skips a coin with no image at all", async () => {
    await recordObservations([observe({ imageUrl: null })], THRESHOLDS, T0);
    expect(await pendingImageWork([mint(1)], T0)).toEqual([]);
  });

  it("does not resurrect a coin evicted between queueing and hashing", async () => {
    // Writing a hash for a coin that is no longer stored would put a coin in
    // the corpus that was never observed.
    expect(await recordPhashes([{ mint: mint(99), phash: "0f0f0f0f0f0f0f0f", state: "ok" }])).toBe(0);
  });
});
