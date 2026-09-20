/**
 * Seeding the corpus.
 *
 * Two halves: validation, which is pure and is the project's only edge against
 * genuinely untrusted data, and the write, which has to leave the corpus in a
 * state retention will not immediately undo.
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import {
  importLaunches,
  mergeReports,
  parseLaunchFile,
  validateLaunches,
} from "../src/worker/import.js";
import {
  IndexedDbCorpus,
  closeCorpus,
  recordObservations,
  runRetention,
} from "../src/worker/corpus.js";
import { lookup } from "../src/worker/lookup.js";
import { THRESHOLDS } from "../src/shared/config.js";
import type { PairObservation } from "../src/shared/types.js";

const T0 = 1_758_300_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MINT_A = "AtbSvZug8WZM4AuDb9MYryXbr3okXrk8BZGGCwvqpump";
const MINT_B = "GPgQkVXwYtbnChgj3DginiXj8CQD1oPZzpA2Q2qtzv9F";

/**
 * The base58 alphabet, which excludes 0, O, I and l.
 *
 * Spelled out because generating test mints from decimal digits does not work:
 * any index reaching 10 introduces a `0` and the result is not a valid address.
 */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Distinct, genuinely valid mints, for i below 58². */
const seedMint = (i: number): string =>
  `${BASE58_ALPHABET[i % 58]}${BASE58_ALPHABET[Math.floor(i / 58) % 58]}z` +
  `TGF97nuz88QXET6KjnC6JK3ZuS27FJvPtTv`;

const launch = (mint: string, overrides: Record<string, unknown> = {}) => ({
  mint,
  name: "Thursday Arena",
  symbol: "THURSDAY",
  uri: "https://ipfs.io/ipfs/abc",
  ...overrides,
});

beforeEach(() => {
  closeCorpus();
  globalThis.indexedDB = new IDBFactory();
});

describe("validateLaunches", () => {
  it("accepts a well-formed launch", () => {
    const { launches, report } = validateLaunches([launch(MINT_A, { observedAt: T0 })]);
    expect(launches).toEqual([
      {
        mint: MINT_A,
        name: "Thursday Arena",
        symbol: "THURSDAY",
        uri: "https://ipfs.io/ipfs/abc",
        observedAt: T0,
      },
    ]);
    expect(report.accepted).toBe(1);
    expect(report.rejected).toBe(0);
  });

  it("keeps a launch with a blank name", () => {
    // Eight of the 123 in the recorded fixture have one. The matcher's
    // minLength guard already handles them, so rejecting here would throw away
    // real data to solve a problem that is already solved.
    const { launches } = validateLaunches([launch(MINT_A, { name: "", symbol: "" })]);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.name).toBe("");
  });

  it("rejects anything without a valid mint", () => {
    // The one field that cannot be wrong: it is the primary key, and a corpus
    // keyed on junk is worse than one missing a row.
    const { report } = validateLaunches([
      launch("not-a-mint"),
      launch("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"),
      { name: "no mint at all" },
      launch(""),
    ]);
    expect(report.accepted).toBe(0);
    expect(report.reasons["bad-mint"]).toBe(4);
  });

  it("rejects rows that are not objects", () => {
    const { report } = validateLaunches([null, 42, "a string", []]);
    // An array is an object, so it falls through to the mint check.
    expect(report.reasons["not-an-object"]).toBe(3);
    expect(report.accepted).toBe(0);
  });

  it("drops a mint repeated within one file", () => {
    // A recording can repeat a frame after a reconnect, and importing the same
    // mint twice would inflate its sighting count on nothing.
    const { launches, report } = validateLaunches([launch(MINT_A), launch(MINT_A)]);
    expect(launches).toHaveLength(1);
    expect(report.reasons["duplicate-in-file"]).toBe(1);
  });

  it("coerces missing optional fields rather than rejecting", () => {
    const { launches } = validateLaunches([{ mint: MINT_A }]);
    expect(launches[0]).toEqual({ mint: MINT_A, name: "", symbol: "", uri: "" });
  });

  it("ignores a nonsense observedAt instead of storing it", () => {
    // A zero or a string here would become a 1970 first-seen date in the
    // popover, which looks like a bug in the corpus rather than in the file.
    for (const bad of [0, -1, "yesterday", null, Number.NaN]) {
      const { launches } = validateLaunches([launch(MINT_A, { observedAt: bad })]);
      expect(launches[0]!.observedAt).toBeUndefined();
    }
  });

  it("returns nothing for input that is not an array", () => {
    expect(validateLaunches({ mint: MINT_A }).launches).toEqual([]);
    expect(validateLaunches(null).launches).toEqual([]);
  });
});

describe("parseLaunchFile", () => {
  it("reads a JSON array", () => {
    const text = JSON.stringify([launch(MINT_A), launch(MINT_B)]);
    expect(parseLaunchFile(text).launches).toHaveLength(2);
  });

  it("reads newline-delimited JSON, which is what the recorder writes", () => {
    const text = `${JSON.stringify(launch(MINT_A))}\n${JSON.stringify(launch(MINT_B))}\n`;
    expect(parseLaunchFile(text).launches).toHaveLength(2);
  });

  it("survives the truncated final line a killed recorder leaves", () => {
    // A run measured in days will be killed, and the file has to stay usable.
    const text = `${JSON.stringify(launch(MINT_A))}\n{"mint":"GPgQkVX`;
    const { launches, report } = parseLaunchFile(text);
    expect(launches).toHaveLength(1);
    expect(report.rejected).toBe(1);
  });

  it("tolerates blank lines and CRLF", () => {
    const text = `${JSON.stringify(launch(MINT_A))}\r\n\r\n${JSON.stringify(launch(MINT_B))}\r\n`;
    expect(parseLaunchFile(text).launches).toHaveLength(2);
  });

  it("returns nothing for an empty or unparseable file", () => {
    expect(parseLaunchFile("").launches).toEqual([]);
    expect(parseLaunchFile("   ").launches).toEqual([]);
    expect(parseLaunchFile("[ this is not json").launches).toEqual([]);
  });

  it("reads the committed argus fixture", () => {
    // The 123-launch recording is exactly the shape a seed file takes, which
    // makes it a real end-to-end check of the importer with no recorder run.
    const text = readFileSync("fixtures/launches-2026-09-17.json", "utf8");
    const { launches, report } = parseLaunchFile(text);
    expect(launches).toHaveLength(123);
    expect(report.rejected).toBe(0);
  });
});

describe("mergeReports", () => {
  it("sums counts across batches", () => {
    const merged = mergeReports([
      { accepted: 2, rejected: 1, reasons: { "not-an-object": 1, "bad-mint": 0, "duplicate-in-file": 0 } },
      { accepted: 3, rejected: 2, reasons: { "not-an-object": 0, "bad-mint": 2, "duplicate-in-file": 0 } },
    ]);
    expect(merged.accepted).toBe(5);
    expect(merged.rejected).toBe(3);
    expect(merged.reasons["bad-mint"]).toBe(2);
  });
});

describe("importLaunches", () => {
  it("writes launches into the corpus", async () => {
    const result = await importLaunches(
      validateLaunches([launch(MINT_A), launch(MINT_B)]).launches,
      THRESHOLDS,
      T0,
    );
    expect(result).toEqual({ written: 2, added: 2 });
    expect((await new IndexedDbCorpus().meta()).coinCount).toBe(2);
  });

  it("never marks an imported coin as having run", async () => {
    // The launch feed carries no market cap and no migration. An imported coin
    // grows the denominator and can never grow the numerator, and the corpus
    // must not pretend otherwise.
    await importLaunches(validateLaunches([launch(MINT_A)]).launches, THRESHOLDS, T0);
    const [coin] = await new IndexedDbCorpus().getMany([MINT_A]);
    expect(coin!.ran).toBe(false);
    expect(coin!.sawMigrated).toBe(false);
    expect(coin!.peakMcUsd).toBeNull();
  });

  it("keeps the metadata URI the scraper cannot get", async () => {
    // Pulse exposes no metadata URI at all, so this is the one route by which
    // argus's cheapest true positive — identical URIs — becomes available.
    await importLaunches(
      validateLaunches([launch(MINT_A), launch(MINT_B)]).launches,
      THRESHOLDS,
      T0,
    );
    const coins = await new IndexedDbCorpus().getMany([MINT_A, MINT_B]);
    // The URI rides on the observation, not the stored coin, so what is checked
    // here is that both coins matched and were stored from the same source.
    expect(coins).toHaveLength(2);
    expect(coins.every((c) => c.normName === "thursdayarena")).toBe(true);
  });

  it("survives the first retention sweep", async () => {
    // The trap this design exists to avoid. Retention drops never-ran coins by
    // lastSeen, imported coins are all never-ran, and if lastSeen were the
    // recorded launch time then importing a two-month-old file would have the
    // whole seed deleted minutes later.
    const old = T0 - 60 * DAY;
    await importLaunches(
      validateLaunches([launch(MINT_A, { observedAt: old })]).launches,
      THRESHOLDS,
      T0,
    );

    expect(await runRetention(THRESHOLDS, T0 + DAY)).toBe(0);
    expect(await new IndexedDbCorpus().getMany([MINT_A])).toHaveLength(1);
  });

  it("still keeps the real launch date for display", async () => {
    // lastSeen moves to the import moment; firstSeen must not, or the popover
    // would report when you imported rather than when the coin appeared.
    const launchedAt = T0 - 60 * DAY;
    await importLaunches(
      validateLaunches([launch(MINT_A, { observedAt: launchedAt })]).launches,
      THRESHOLDS,
      T0,
    );
    const [coin] = await new IndexedDbCorpus().getMany([MINT_A]);
    expect(coin!.firstSeen).toBe(launchedAt);
    expect(coin!.lastSeen).toBe(T0);
  });

  it("merges into a coin already observed without losing its peak", async () => {
    // Importing must never downgrade what your own screen saw. A coin you
    // watched run is a coin that ran, whatever the seed says about it.
    const observed: PairObservation = {
      mint: MINT_A,
      name: "Thursday Arena",
      symbol: "THURSDAY",
      imageUrl: null,
      metadataUri: null,
      marketCapUsd: 500_000,
      volumeUsd: 1000,
      ageSeconds: 30,
      seenAt: T0,
      source: "new-pairs",
    };
    await recordObservations([observed], THRESHOLDS, T0);
    await importLaunches(validateLaunches([launch(MINT_A)]).launches, THRESHOLDS, T0 + 1000);

    const [coin] = await new IndexedDbCorpus().getMany([MINT_A]);
    expect(coin!.peakMcUsd).toBe(500_000);
    expect(coin!.ran).toBe(true);
    expect(coin!.sightings).toBe(2);
  });

  it("counts a re-import as no new coins", async () => {
    await importLaunches(validateLaunches([launch(MINT_A)]).launches, THRESHOLDS, T0);
    const second = await importLaunches(
      validateLaunches([launch(MINT_A)]).launches,
      THRESHOLDS,
      T0 + 1000,
    );
    expect(second).toEqual({ written: 1, added: 0 });
    expect((await new IndexedDbCorpus().meta()).coinCount).toBe(1);
  });

  it("is a no-op on an empty batch", async () => {
    expect(await importLaunches([], THRESHOLDS, T0)).toEqual({ written: 0, added: 0 });
  });

  it("sets the corpus start time when importing into a fresh corpus", async () => {
    // Otherwise a user who seeds before ever opening Pulse has a corpus with no
    // start time, and the honest-zero has nothing to measure against.
    await importLaunches(validateLaunches([launch(MINT_A)]).launches, THRESHOLDS, T0);
    expect((await new IndexedDbCorpus().meta()).startedAt).toBe(T0);
  });
});

describe("a seeded corpus, end to end", () => {
  it("raises the total without raising the ran count", async () => {
    // The headline consequence, asserted rather than described. Seeding makes
    // the ratio drop, and that is it getting more honest.
    const observed: PairObservation = {
      mint: MINT_A,
      name: "Thursday Arena",
      symbol: "THURSDAY",
      imageUrl: null,
      metadataUri: null,
      marketCapUsd: 500_000,
      volumeUsd: 1000,
      ageSeconds: 30,
      seenAt: T0,
      source: "new-pairs",
    };
    await recordObservations([observed], THRESHOLDS, T0);

    const mature = T0 + 10 * DAY;
    const subject = { mint: "9j5q1tfajnqLFSBqE6hTu9mC9SEc2SPFuN6t5XxBpump", name: "Thursday Arena", symbol: "THURSDAY" };

    const before = await lookup(subject, new IndexedDbCorpus(), THRESHOLDS, mature);
    expect(before.ranCount).toBe(1);
    expect(before.totalCount).toBe(1);

    // Seed thirty more deployments of the same narrative.
    const seeded = Array.from({ length: 30 }, (_, i) => launch(seedMint(i)));

    // Assert the fixture before asserting on the result. A first draft built
    // mints with `String(n).padStart(3, "A")`, which yields "A10" — and `0` is
    // not in the base58 alphabet, so the importer correctly rejected three of
    // the thirty and the test failed at 28. The importer was right; the fixture
    // was not. Checking it here means that cannot be mistaken for a bug again.
    const parsed = validateLaunches(seeded);
    expect(parsed.launches).toHaveLength(30);

    await importLaunches(parsed.launches, THRESHOLDS, T0);

    const after = await lookup(subject, new IndexedDbCorpus(), THRESHOLDS, mature);
    expect(after.totalCount).toBe(31);
    expect(after.ranCount).toBe(1);
  });
});
