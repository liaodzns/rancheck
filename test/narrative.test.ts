/**
 * The port's own behaviour.
 *
 * These are unit facts about `normalize`, `jaroWinkler` and `matchNarrative`
 * held in isolation. The claims measured against the real recording live in
 * `fixture.test.ts`; this file is what tells you *which part* broke when that
 * one goes red.
 */
import { describe, expect, it } from "vitest";
import { jaroWinkler, matchNarrative, normalize } from "../src/worker/match.js";
import { THRESHOLDS } from "../src/shared/config.js";

const cfg = THRESHOLDS.narrative;

describe("normalize", () => {
  it("folds the variations a clone actually uses", () => {
    // Case, spacing and punctuation are all things a clone varies without
    // changing what it is pretending to be.
    expect(normalize("THURSDAY ARENA")).toBe("thursdayarena");
    expect(normalize("Thursday-Arena!")).toBe("thursdayarena");
    expect(normalize("  thursday   arena  ")).toBe("thursdayarena");
  });

  it("strips emoji and accents rather than treating them as difference", () => {
    expect(normalize("Thursday 🔥 Arena")).toBe("thursdayarena");
    expect(normalize("Thürsdáy Arena")).toBe("thursdayarena");
  });

  it("folds NFKD lookalikes, which exist to dodge exact-match filters", () => {
    // Fullwidth Latin. A filter comparing raw strings sees a different token;
    // a human scrolling the feed does not.
    expect(normalize("ＴＨＵＲＳＤＡＹ")).toBe("thursday");
  });

  it("drops filler that clones add and remove freely", () => {
    expect(normalize("Thursday Arena Coin")).toBe("thursdayarena");
    expect(normalize("The Thursday Arena Token")).toBe("thursdayarena");
    expect(normalize("Thursday Arena V2")).toBe("thursdayarena");
    expect(normalize("Thursday Arena SOL")).toBe("thursdayarena");
  });

  it("strips filler only as a whole word, so distinct tokens do not collide", () => {
    // The FILLER list is deliberately short and \b-anchored. Over-stripping is
    // the failure mode that matters: it turns unrelated coins into matches.
    expect(normalize("Solaris")).toBe("solaris");
    expect(normalize("Theory")).toBe("theory");
    expect(normalize("Bitcoin")).toBe("bitcoin");
  });

  it("collapses a blank or symbol-only name to the empty string", () => {
    // This is what makes the minLength guard able to see them.
    expect(normalize("")).toBe("");
    expect(normalize("   ")).toBe("");
    expect(normalize("!!!")).toBe("");
    expect(normalize("🔥🔥")).toBe("");
  });
});

describe("jaroWinkler", () => {
  it("rewards a shared prefix, because the common clone appends", () => {
    // The prefix bonus is the point of choosing Winkler over plain Jaro.
    const appended = jaroWinkler("thursdayarena", "thursdayarena2");
    const prefixed = jaroWinkler("thursdayarena", "2thursdayarena");
    expect(appended).toBeGreaterThan(prefixed);
  });

  it("scores identical strings 1 and unrelated strings low", () => {
    expect(jaroWinkler("cupcake", "cupcake")).toBe(1);
    expect(jaroWinkler("cupcake", "zogcash")).toBeLessThan(0.7);
  });
});

describe("matchNarrative", () => {
  const cupcakeClone = { name: "thursdayarena", symbol: "CUPCAKE", uri: "ipfs://clone" };
  const parent = { name: "THURSDAY ARENA", symbol: "THURSDAY", uri: "ipfs://parent" };

  it("matches on either field alone", () => {
    // Requiring name AND ticker to agree would have missed the real wave
    // outright. The clone's ticker carries no signal; its name carries all.
    const result = matchNarrative(parent, cupcakeClone, cfg);
    expect(result).not.toBeNull();
    expect(result!.similarity).toBe(1);
  });

  it("tries cross pairings, not just name-to-name", () => {
    // A clone that puts the parent's ticker in its name field is still a clone.
    const crossed = { name: "THURSDAY", symbol: "ZZZZ", uri: "" };
    const result = matchNarrative(parent, crossed, cfg);
    expect(result).not.toBeNull();
    expect(result!.matchedOn).toContain("symbol");
  });

  it("reports matchedOn as what was recognisable, not as field equality", () => {
    // Both are reported because both the parent's name and its ticker turn up
    // inside the clone's name field. The two coins' names are NOT equal and
    // their symbols are NOT equal, so any UI rendering this as "name and
    // symbol match" would be lying.
    const result = matchNarrative(parent, cupcakeClone, cfg);
    expect(result!.matchedOn).toEqual(["name", "symbol"]);
    expect(parent.name).not.toBe(cupcakeClone.name);
    expect(parent.symbol).not.toBe(cupcakeClone.symbol);
  });

  it("short-circuits an identical metadata URI to 1", () => {
    // Two launches pointing at the same metadata are the same token described
    // twice, and it costs no network call to notice. Note the names disagree
    // completely here and it still scores 1.
    const a = { name: "Alpha", symbol: "AAA", uri: "ipfs://same" };
    const b = { name: "Totally Different", symbol: "ZZZ", uri: "ipfs://same" };
    expect(matchNarrative(a, b, cfg)).toEqual({ similarity: 1, matchedOn: ["metadata"] });
  });

  it("does not treat two missing URIs as an identical one", () => {
    // The blank-name failure, in the metadata domain. Seven of the 123 recorded
    // launches have uri "", and short-circuiting those to 1.0 would fuse them.
    const a = { name: "Alpha", symbol: "AAA", uri: "" };
    const b = { name: "Beta", symbol: "BBB", uri: "" };
    expect(matchNarrative(a, b, cfg)).toBeNull();
  });

  it("refuses to compare fields under minLength", () => {
    // Load-bearing, not defensive: two blanks score 1.0, so without this a
    // nameless token matches every row on your screen.
    const blank = { name: "", symbol: "", uri: "" };
    expect(matchNarrative(blank, blank, cfg)).toBeNull();
    expect(matchNarrative({ name: "T", symbol: "T", uri: "" }, blank, cfg)).toBeNull();
  });

  it("would match blanks to everything if the guard were removed", () => {
    // Proves the guard is the thing doing the work, not an accident of the
    // threshold. With minLength 0 a blank matches a blank at 1.0.
    const blank = { name: "", symbol: "", uri: "" };
    const unguarded = { minSimilarity: cfg.minSimilarity, minLength: 0 };
    expect(matchNarrative(blank, blank, unguarded)).toEqual({
      similarity: 1,
      matchedOn: ["name", "symbol"],
    });
  });

  it("returns null below the similarity threshold", () => {
    const a = { name: "Chaotic Rocket", symbol: "ROCKET", uri: "" };
    const b = { name: "Roam LaunchPad", symbol: "ROAM", uri: "" };
    expect(matchNarrative(a, b, cfg)).toBeNull();
  });
});
