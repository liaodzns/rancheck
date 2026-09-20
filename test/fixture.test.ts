/**
 * The known facts, against the real recording.
 *
 * `fixtures/launches-2026-09-17.json` is 123 pump.fun launches captured over
 * four minutes at 31 launches/minute, and it happens to contain a genuine vamp
 * wave. Waves like it cannot be caught on demand, which is why the file is kept
 * rather than re-recorded, and why these numbers are asserted exactly rather
 * than as ranges: every one is a measurement, and a change to any of them means
 * the matcher's behaviour moved.
 *
 * If one of these goes red, the question is not "what should the number be
 * now". It is "what did I change, and why did I think I was allowed to".
 */
import { describe, expect, it } from "vitest";
import launches from "../fixtures/launches-2026-09-17.json";
import { matchNarrative, normalize } from "../src/worker/match.js";
import { clusterByNarrative, matchCorpus } from "../src/worker/match-corpus.js";
import { THRESHOLDS } from "../src/shared/config.js";
import type { MintEvent } from "../src/shared/types.js";

const cfg = THRESHOLDS.narrative;
const LAUNCHES = launches as MintEvent[];

describe("the recording", () => {
  it("is the 123 launches the README describes", () => {
    expect(LAUNCHES).toHaveLength(123);
    for (const launch of LAUNCHES) {
      expect(typeof launch.mint).toBe("string");
      expect(launch.mint.length).toBeGreaterThan(31);
    }
  });
});

describe("the Thursday Arena wave", () => {
  const clusters = clusterByNarrative(LAUNCHES, cfg);
  const wave = clusters[0]!;

  it("clusters to 27 members out of 123", () => {
    // The spec says "~25" from an earlier read of this same data; measured at
    // min_similarity 0.90 it is 27. Recorded as the exact figure, because a
    // drift of even one member is worth noticing.
    expect(wave).toHaveLength(27);
  });

  it("is one wave despite the ticker mutating across three values", () => {
    const symbols = new Set(wave.map((c) => c.symbol.toUpperCase()));
    expect(symbols).toContain("THURSDAY");
    expect(symbols).toContain("THURSDAYARENA");
    expect(symbols).toContain("CUPCAKE");
  });

  it("holds together only through single-link bridging", () => {
    // `Cupcake`/`CUPCAKE` and `THURSDAY ARENA`/`THURSDAY` share nothing and do
    // not match each other. They are one wave because `thursdayarena`/`CUPCAKE`
    // sits between them and matches both. Demand that every member match every
    // other and the wave splits into the pieces its deployer mutated between,
    // which is the opposite of what a count is supposed to mean.
    const pureCupcake = wave.find((c) => normalize(c.name) === "cupcake")!;
    const pureThursday = wave.find((c) => normalize(c.symbol) === "thursday")!;
    expect(matchNarrative(pureCupcake, pureThursday, cfg)).toBeNull();

    const bridge = wave.find(
      (c) => normalize(c.name) === "thursdayarena" && normalize(c.symbol) === "cupcake",
    )!;
    expect(matchNarrative(bridge, pureCupcake, cfg)).not.toBeNull();
    expect(matchNarrative(bridge, pureThursday, cfg)).not.toBeNull();
  });

  it("is the only large cluster; everything else is noise or a small group", () => {
    // The bimodality, seen from the clustering side. Second-largest is 5.
    expect(clusters[1]!.length).toBe(5);
  });
});

describe("CUPCAKE with the name thursdayarena", () => {
  // The case that proves a matcher cannot require name AND ticker to agree.
  const clone = LAUNCHES.find(
    (l) => l.symbol === "CUPCAKE" && normalize(l.name) === "thursdayarena",
  )!;
  const parent = LAUNCHES.find(
    (l) => l.symbol === "THURSDAY" && normalize(l.name) === "thursdayarena",
  )!;

  it("exists in the recording, with a ticker the parent does not share", () => {
    expect(clone).toBeDefined();
    expect(parent).toBeDefined();
    expect(clone.symbol).not.toBe(parent.symbol);
  });

  it("matches the parent at 1.0, carried entirely by the name", () => {
    const result = matchNarrative(parent, clone, cfg);
    expect(result).not.toBeNull();
    expect(result!.similarity).toBe(1);
    expect(result!.matchedOn).toContain("name");
  });

  it("would be missed by a matcher requiring both fields to agree", () => {
    const bothAgree =
      normalize(parent.name) === normalize(clone.name) &&
      normalize(parent.symbol) === normalize(clone.symbol);
    expect(bothAgree).toBe(false);
  });
});

describe("launches with nothing to match on", () => {
  // The spec calls these "the 8 blank names". Precisely: 7 have an empty name
  // and an empty symbol, and one is named "T" with ticker "T", which normalises
  // to a single character. All 8 fall under minLength, which is the property
  // that matters — the guard is about comparability, not about emptiness.
  const unmatchable = LAUNCHES.filter(
    (l) => normalize(l.name).length < cfg.minLength && normalize(l.symbol).length < cfg.minLength,
  );

  it("number 8 of the 123", () => {
    expect(unmatchable).toHaveLength(8);
    expect(unmatchable.filter((l) => l.name === "" && l.symbol === "")).toHaveLength(7);
  });

  it("do not match each other", () => {
    for (let i = 0; i < unmatchable.length; i++) {
      for (let j = i + 1; j < unmatchable.length; j++) {
        expect(matchNarrative(unmatchable[i]!, unmatchable[j]!, cfg)).toBeNull();
      }
    }
  });

  it("do not match anything at all in the corpus", () => {
    // The real failure this prevents: a nameless row badged against every coin
    // on screen. These also share uri "", so it covers the metadata path too.
    for (const blank of unmatchable) {
      expect(matchCorpus(blank, LAUNCHES, cfg, { excludeMint: blank.mint })).toHaveLength(0);
    }
  });
});

describe("identical metadata URIs", () => {
  const groups = [
    ...LAUNCHES.reduce((acc, l) => {
      if (l.uri === "") return acc;
      const bucket = acc.get(l.uri) ?? [];
      bucket.push(l);
      acc.set(l.uri, bucket);
      return acc;
    }, new Map<string, MintEvent[]>()).values(),
  ].filter((g) => g.length > 1);

  it("form 7 groups in the recording", () => {
    expect(groups).toHaveLength(7);
    expect(groups.map((g) => g.length).sort((a, b) => a - b)).toEqual([2, 2, 2, 2, 3, 3, 5]);
  });

  it("score 1.0 through the metadata path", () => {
    for (const group of groups) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          expect(matchNarrative(group[i]!, group[j]!, cfg)).toEqual({
            similarity: 1,
            matchedOn: ["metadata"],
          });
        }
      }
    }
  });

  it("are distinct mints describing the same token", () => {
    // Which is what makes this the cheapest true positive available: no network
    // call, no text comparison, no threshold.
    for (const group of groups) {
      expect(new Set(group.map((g) => g.mint)).size).toBe(group.length);
    }
  });
});

describe("the shape of the result", () => {
  const counts = LAUNCHES.map((l) => matchCorpus(l, LAUNCHES, cfg, { excludeMint: l.mint }).length);

  it("is bimodal, with a literally empty gap between the two modes", () => {
    // The full distribution of per-launch match counts is
    //   0:66  1:10  2:15  4:5  |  11:2  24:15  26:10
    // Ninety-six launches match four or fewer; twenty-seven match eleven or
    // more; not one lands in between. That emptiness is the real signal, and it
    // is why the exact threshold barely matters — any value in the gap gives
    // the same answer. It is also the reason a badge can be trusted: there is
    // no ambiguous middle for it to misreport.
    expect(counts.filter((c) => c <= 4).length).toBe(96);
    expect(counts.filter((c) => c >= 5 && c <= 10)).toEqual([]);
    expect(counts.filter((c) => c >= 11).length).toBe(27);
  });

  it("has half of all launches matching nothing at all", () => {
    expect(counts.filter((c) => c === 0).length).toBe(66);
  });

  it("means 5.71 matches per launch", () => {
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(mean).toBeCloseTo(5.71, 2);
  });

  it("gets almost all of that from exact equality after normalisation", () => {
    // The finding that decides the architecture: the exact-match path is the
    // fast path and it is nearly as good as the full one, so the inline badge
    // can run on it and full fuzzy scoring can be reserved for the popover.
    let exact = 0;
    for (const a of LAUNCHES) {
      const aKeys = [normalize(a.name), normalize(a.symbol)].filter(
        (s) => s.length >= cfg.minLength,
      );
      for (const b of LAUNCHES) {
        if (a.mint === b.mint) continue;
        const bKeys = [normalize(b.name), normalize(b.symbol)].filter(
          (s) => s.length >= cfg.minLength,
        );
        if (aKeys.some((k) => bKeys.includes(k))) exact++;
      }
    }
    const exactMean = exact / LAUNCHES.length;
    const fullMean = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(exactMean).toBeCloseTo(5.64, 2);
    // The fuzzy layer earns about 1% more. Keep it for the wave that renames
    // creatively; do not spend time tuning it.
    expect(fullMean - exactMean).toBeLessThan(0.1);
  });
});
