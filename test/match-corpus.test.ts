/**
 * The corpus wrapper.
 *
 * Everything here is about iteration, self-exclusion and ordering. The matching
 * itself is the frozen port's and is tested in `narrative.test.ts`; nothing in
 * this file should ever need to assert a similarity value it computed itself.
 */
import { describe, expect, it } from "vitest";
import { clusterByNarrative, matchCorpus, type NarrativeCandidate } from "../src/worker/match-corpus.js";
import { THRESHOLDS } from "../src/shared/config.js";

const cfg = THRESHOLDS.narrative;

/**
 * A corpus row that is also usable as a subject.
 *
 * `uri` is required here even though `NarrativeCandidate` leaves it optional,
 * because a subject is a `MintEvent` and that carries a concrete string. The
 * empty-string default is the same thing the scraper will do with a null
 * `metadataUri`, and the port declines to short-circuit on it — see
 * "does not treat two missing URIs as an identical one" in narrative.test.ts.
 */
const coin = (
  mint: string,
  name: string,
  symbol: string,
  uri = "",
): NarrativeCandidate & { uri: string } => ({ mint, name, symbol, uri });

describe("matchCorpus", () => {
  const corpus = [
    coin("m1", "Thursday Arena", "THURSDAY"),
    coin("m2", "thursdayarena", "CUPCAKE"),
    coin("m3", "Chaotic Rocket", "ROCKET"),
    coin("m4", "Roam LaunchPad", "ROAM"),
  ];

  it("returns only the candidates that matched", () => {
    const hits = matchCorpus(coin("new", "THURSDAY ARENA", "ARENA"), corpus, cfg);
    expect(hits.map((h) => h.candidate.mint)).toEqual(["m1", "m2"]);
  });

  it("excludes the subject's own mint", () => {
    // The subject is usually a freshly scraped observation and the candidate a
    // stored row: different objects, same coin. Without this every count is
    // inflated by exactly one, and every coin looks like it has run before.
    const self = corpus[0]!;
    const withSelf = matchCorpus(self, corpus, cfg);
    const withoutSelf = matchCorpus(self, corpus, cfg, { excludeMint: self.mint });
    expect(withSelf).toHaveLength(withoutSelf.length + 1);
    expect(withoutSelf.map((h) => h.candidate.mint)).not.toContain("m1");
  });

  it("orders by similarity, best first", () => {
    const fuzzy = coin("m5", "Thursday Arenaa", "ZZZZ");
    const hits = matchCorpus(coin("new", "thursdayarena", "THURSDAY"), [...corpus, fuzzy], cfg);
    const sims = hits.map((h) => h.similarity);
    expect(sims).toEqual([...sims].sort((a, b) => b - a));
    expect(hits[hits.length - 1]!.candidate.mint).toBe("m5");
  });

  it("breaks ties by mint so the order does not depend on input order", () => {
    // Input order is IndexedDB cursor order, which the UI has no business
    // depending on.
    const a = [coin("bbb", "Cupcake", "CUPCAKE"), coin("aaa", "cupcake", "CUPCAKE")];
    const forward = matchCorpus(coin("new", "Cupcake", "CUPCAKE"), a, cfg);
    const reversed = matchCorpus(coin("new", "Cupcake", "CUPCAKE"), [...a].reverse(), cfg);
    expect(forward.map((h) => h.candidate.mint)).toEqual(["aaa", "bbb"]);
    expect(reversed.map((h) => h.candidate.mint)).toEqual(["aaa", "bbb"]);
  });

  it("carries the port's result through untouched", () => {
    const hits = matchCorpus(coin("new", "thursdayarena", "CUPCAKE"), corpus, cfg);
    const hit = hits.find((h) => h.candidate.mint === "m2")!;
    expect(hit.similarity).toBe(1);
    expect(hit.matchedOn).toEqual(["name", "symbol"]);
  });

  it("passes the metadata shortcut through", () => {
    const shared = [coin("m9", "Anything At All", "ZZZ", "ipfs://same")];
    const hits = matchCorpus(coin("new", "Nothing Alike", "QQQ", "ipfs://same"), shared, cfg);
    expect(hits[0]!.matchedOn).toEqual(["metadata"]);
  });

  it("returns nothing for an empty candidate list", () => {
    // The cold-corpus case, which is day one of using this extension.
    expect(matchCorpus(coin("new", "Thursday Arena", "THURSDAY"), [], cfg)).toEqual([]);
  });
});

describe("clusterByNarrative", () => {
  it("joins through a bridge that matches both ends", () => {
    // Single link, on purpose. A and C do not match; both match B.
    const groups = clusterByNarrative(
      [
        coin("a", "Cupcake", "CUPCAKE"),
        coin("b", "thursdayarena", "CUPCAKE"),
        coin("c", "Thursday Arena", "THURSDAY"),
      ],
      cfg,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("leaves unrelated launches as singletons", () => {
    const groups = clusterByNarrative(
      [coin("a", "Chaotic Rocket", "ROCKET"), coin("b", "Roam LaunchPad", "ROAM")],
      cfg,
    );
    expect(groups.map((g) => g.length)).toEqual([1, 1]);
  });

  it("keeps unmatchable launches apart rather than fusing them", () => {
    const groups = clusterByNarrative([coin("a", "", ""), coin("b", "", ""), coin("c", "T", "T")], cfg);
    expect(groups.map((g) => g.length)).toEqual([1, 1, 1]);
  });

  it("returns clusters largest first", () => {
    const groups = clusterByNarrative(
      [
        coin("a", "Cupcake", "CUPCAKE"),
        coin("b", "cupcake", "CUPCAKE"),
        coin("c", "Chaotic Rocket", "ROCKET"),
      ],
      cfg,
    );
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });

  it("accounts for every input exactly once", () => {
    const input = [
      coin("a", "Cupcake", "CUPCAKE"),
      coin("b", "thursdayarena", "CUPCAKE"),
      coin("c", "Roam LaunchPad", "ROAM"),
      coin("d", "", ""),
    ];
    const groups = clusterByNarrative(input, cfg);
    const seen = groups.flat().map((g) => g.mint).sort();
    expect(seen).toEqual(["a", "b", "c", "d"]);
  });
});
