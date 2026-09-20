/**
 * Assembly, deduplication and extraction telemetry.
 */
import { describe, expect, it } from "vitest";
import {
  ExtractionTally,
  dedupeByMint,
  diagnose,
  toObservation,
  type RawRow,
} from "../src/content/observation.js";
import type { PairObservation } from "../src/shared/types.js";

const MINT = "AtbSvZug8WZM4AuDb9MYryXbr3okXrk8BZGGCwvqpump";
const OTHER = "GPgQkVXwYtbnChgj3DginiXj8CQD1oPZzpA2Q2qtzv9F";
const NOW = 1_758_300_000_000;

/** A complete row, as the Final Stretch card for TBC renders it. */
const row = (overrides: Partial<RawRow> = {}): RawRow => ({
  mintHref: `/meme/${MINT}`,
  mintText: null,
  name: "The Boring Company",
  symbol: "TBC",
  imageUrl: "https://cdn.example/tbc.png",
  metadataUri: null,
  marketCap: "$44.8K",
  volume: "$80K",
  age: "9m",
  ...overrides,
});

describe("toObservation", () => {
  it("builds a complete observation from a complete row", () => {
    const { observation } = toObservation(row(), "new-pairs", NOW);
    expect(observation).toEqual<PairObservation>({
      mint: MINT,
      name: "The Boring Company",
      symbol: "TBC",
      imageUrl: "https://cdn.example/tbc.png",
      metadataUri: null,
      marketCapUsd: 44800,
      volumeUsd: 80000,
      ageSeconds: 540,
      seenAt: NOW,
      source: "new-pairs",
    });
  });

  it("keeps a row whose optional columns did not resolve", () => {
    // A scraper that throws because a redesign moved the volume column is worse
    // than one returning nulls: the mint and the name are what matching needs.
    const { observation } = toObservation(
      row({ marketCap: null, volume: "—", age: "garbage", imageUrl: null }),
      "new-pairs",
      NOW,
    );
    expect(observation).not.toBeNull();
    expect(observation!.name).toBe("The Boring Company");
    expect(observation!.marketCapUsd).toBeNull();
    expect(observation!.volumeUsd).toBeNull();
    expect(observation!.ageSeconds).toBeNull();
  });

  it("drops a row with no usable mint, and says why", () => {
    for (const href of [null, "/portfolio", "/meme/trending"]) {
      const result = toObservation(row({ mintHref: href }), "new-pairs", NOW);
      expect(result.observation).toBeNull();
      expect(result.rejected).toBe("no-mint");
    }
  });

  it("drops a row whose footer mint contradicts its link", () => {
    // What a recycled virtualised node looks like mid-update. Storing it would
    // attribute one coin's market cap to another.
    const result = toObservation(row({ mintText: "Grmg...pump" }), "new-pairs", NOW);
    expect(result.observation).toBeNull();
    expect(result.rejected).toBe("mint-mismatch");
  });

  it("keeps a row whose footer mint agrees with its link", () => {
    const head = MINT.slice(0, 4);
    const tail = MINT.slice(-4);
    const result = toObservation(row({ mintText: `${head}...${tail}` }), "new-pairs", NOW);
    expect(result.observation).not.toBeNull();
  });

  it("records the source it was scraped from", () => {
    // The same coin in Final Stretch and in New Pairs is two sightings from two
    // columns, and phase 3's "did it run" classifier cares which.
    const fromMigrated = toObservation(row(), "migrated" as never, NOW);
    expect(fromMigrated.observation!.source).toBe("migrated");
  });
});

describe("dedupeByMint", () => {
  const observe = (mint: string, overrides: Partial<PairObservation> = {}): PairObservation => ({
    mint,
    name: "FINESHYT",
    symbol: "fineshyt",
    imageUrl: null,
    metadataUri: null,
    marketCapUsd: 9640,
    volumeUsd: 11000,
    ageSeconds: 29,
    seenAt: NOW,
    source: "new-pairs",
    ...overrides,
  });

  it("collapses a coin that is rendered in two columns at once", () => {
    // FINESHYT sits in both New Pairs and Final Stretch on the captured screen,
    // with identical numbers. Counting it twice per tick would inflate the
    // sighting count on nothing but layout.
    const deduped = dedupeByMint([
      observe(MINT, { source: "new-pairs" }),
      observe(MINT, { source: "trending" }),
      observe(OTHER),
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((o) => o.mint).sort()).toEqual([MINT, OTHER].sort());
  });

  it("keeps the most complete row rather than the first", () => {
    const sparse = observe(MINT, { marketCapUsd: null, volumeUsd: null, ageSeconds: null });
    const full = observe(MINT, { imageUrl: "https://cdn.example/a.png" });
    expect(dedupeByMint([sparse, full])[0]).toBe(full);
    expect(dedupeByMint([full, sparse])[0]).toBe(full);
  });

  it("breaks a completeness tie towards the earlier column", () => {
    const first = observe(MINT, { source: "new-pairs" });
    const second = observe(MINT, { source: "trending" });
    expect(dedupeByMint([first, second])[0]!.source).toBe("new-pairs");
  });

  it("passes an empty pass through", () => {
    expect(dedupeByMint([])).toEqual([]);
  });
});

describe("ExtractionTally", () => {
  const tally = (rows: RawRow[]): ExtractionTally => {
    const t = new ExtractionTally();
    for (const r of rows) t.record(toObservation(r, "new-pairs", NOW));
    return t;
  };

  it("reports a clean pass as fully resolved", () => {
    const report = tally(Array.from({ length: 25 }, () => row())).report();
    expect(report.rows).toBe(25);
    expect(report.kept).toBe(25);
    expect(report.rates.name).toBe(1);
    expect(report.rates.marketCapUsd).toBe(1);
    // metadataUri is never in the Pulse markup, so it is legitimately 0%.
    expect(report.rates.metadataUri).toBe(0);
  });

  it("counts rejections by reason rather than losing them", () => {
    const report = tally([
      row(),
      row({ mintHref: null }),
      row({ mintText: "Grmg...pump" }),
    ]).report();
    expect(report.rows).toBe(3);
    expect(report.kept).toBe(1);
    expect(report.rejected["no-mint"]).toBe(1);
    expect(report.rejected["mint-mismatch"]).toBe(1);
  });

  it("computes rates over kept rows, not over all rows", () => {
    // A row with no mint never had a name to extract either. Counting it
    // against the name rate would blame the wrong selector.
    const report = tally([row(), row({ mintHref: null })]).report();
    expect(report.kept).toBe(1);
    expect(report.rates.name).toBe(1);
  });

  it("resets", () => {
    const t = tally([row()]);
    t.reset();
    expect(t.report().rows).toBe(0);
    expect(t.report().rates.name).toBe(0);
  });
});

describe("diagnose", () => {
  const reportOf = (rows: RawRow[]) => {
    const t = new ExtractionTally();
    for (const r of rows) t.record(toObservation(r, "new-pairs", NOW));
    return t.report();
  };

  const many = (n: number, overrides: Partial<RawRow> = {}) =>
    Array.from({ length: n }, () => row(overrides));

  it("withholds judgement on a small sample", () => {
    // A rate over three rows is noise, and crying redesign at every mid-render
    // column would train the warning to be ignored.
    const d = diagnose(reportOf(many(3)));
    expect(d.health).toBe("cold");
  });

  it("passes a healthy pass", () => {
    expect(diagnose(reportOf(many(25))).health).toBe("ok");
  });

  it("names the redesign shape the spec warns about", () => {
    // Names drop to 0% while mints keep working. This is what a redesign looks
    // like from the inside — not an error, just a field quietly going empty.
    const d = diagnose(reportOf(many(25, { name: null, symbol: null })));
    expect(d.health).toBe("fields-failing");
    expect(d.failing).toEqual(["name", "symbol"]);
    expect(d.message).toContain("name 0%");
    expect(d.message).toContain("redesign");
  });

  it("blames the anchor, not the fields, when every mint is gone", () => {
    // If mints fail, every other rate is computed over nothing, and reporting
    // a name failure would point at the wrong file to fix.
    const d = diagnose(reportOf(many(25, { mintHref: null })));
    expect(d.health).toBe("mints-failing");
    expect(d.failing).toEqual([]);
  });

  it("never flags metadataUri, which Axiom may simply not expose", () => {
    // A field that has always been 0% is not a regression.
    const d = diagnose(reportOf(many(25)));
    expect(d.health).toBe("ok");
    expect(d.failing).not.toContain("metadataUri");
  });

  it("tolerates a field that is merely often absent", () => {
    // A brand-new pair genuinely has no volume yet. The floor is set well below
    // any real absence rate so those do not read as breakage.
    const mixed = [...many(20), ...many(5, { volume: null })];
    expect(diagnose(reportOf(mixed)).health).toBe("ok");
  });
});
