/**
 * The scraper, against a real captured Axiom page.
 *
 * `fixtures/axiom-dom/pulse-2026-09-19.html` is a live Pulse screen, scrubbed
 * by `scripts/scrub-dom-fixture.mjs` and otherwise untouched. Every expectation
 * here is a fact about that capture, so a redesign that breaks the scraper
 * breaks these tests rather than silently returning nulls in production.
 *
 * The per-field rates are asserted as exact counts. That is the metric the spec
 * says to judge this phase on, and a rate that drifts is the earliest warning
 * available that something has moved.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import { scrape } from "../src/content/scrape.js";
import { toObservation } from "../src/content/observation.js";
import { columnOf, describeCard, findCards, mintOf, readCard } from "../src/content/selectors.js";
import type { ScrapeResult } from "../src/content/scrape.js";

const FIXTURE = new URL("../fixtures/axiom-dom/pulse-2026-09-19.html", import.meta.url);
const NOW = 1_758_300_000_000;

let doc: Document;
let result: ScrapeResult;

beforeAll(() => {
  const dom = new JSDOM(readFileSync(FIXTURE, "utf8"), { url: "https://axiom.trade/pulse" });
  doc = dom.window.document;
  result = scrape(doc, { now: NOW });
});

describe("finding cards", () => {
  it("finds all 30 cards across the three columns", () => {
    expect(findCards(doc)).toHaveLength(30);
  });

  it("ignores the ticker strip, which is anchors but not pairs", () => {
    // The capture holds 15 `a[href*="/meme/"]` anchors and every one is in the
    // price ticker along the top. The spec's original rule would have returned
    // them as pairs — 15 plausible rows from a strip that is not the feed.
    // This is the test that would have caught that.
    const tickerAnchors = doc.querySelectorAll('a[href*="/meme/"]');
    expect(tickerAnchors.length).toBeGreaterThan(0);

    const ticker = tickerAnchors[0]!.closest("section")!;
    expect(findCards(ticker)).toHaveLength(0);
  });
});

describe("column detection", () => {
  it("splits the cards across New Pairs, Final Stretch and Migrated", () => {
    const counts = new Map<string, number>();
    for (const card of findCards(doc)) {
      const source = columnOf(card);
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
    expect(counts.get("new-pairs")).toBe(12);
    expect(counts.get("final-stretch")).toBe(6);
    expect(counts.get("migrated")).toBe(12);
    expect(counts.get("other")).toBeUndefined();
  });

  it("gives every migrated coin the source the run classifier needs", () => {
    // Phase 4's "did it run" rule reads this. A coin in Migrated completed its
    // bonding curve, which is the one run signal that does not depend on having
    // had the tab open at the right moment.
    const migrated = result.observations.filter((o) => o.source === "migrated");
    expect(migrated).toHaveLength(12);
  });
});

describe("mint extraction", () => {
  it("resolves a full base58 mint on every card", () => {
    const mints = findCards(doc).map(mintOf);
    expect(mints.filter((m) => m === null)).toHaveLength(0);
    for (const mint of mints) {
      expect(mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });

  it("agrees with the truncated mint Axiom prints on the card", () => {
    // The cross-check that catches a recycled virtualised node mid-update.
    for (const card of findCards(doc)) {
      const mint = mintOf(card)!;
      const raw = readCard(card);
      if (raw.mintText === null) continue;
      const [head, tail] = raw.mintText.split("...") as [string, string];
      expect(mint.startsWith(head)).toBe(true);
      expect(mint.endsWith(tail)).toBe(true);
    }
  });

  it("survives losing the attribute, via the image filename", () => {
    // The attribute is the primary source but not the only one: Axiom's CDN
    // names the token image after the mint, which is a genuinely independent
    // second witness.
    const card = findCards(doc)[0]!.cloneNode(true) as Element;
    const expected = mintOf(findCards(doc)[0]!);
    card.removeAttribute("data-pulse-token-address");
    expect(mintOf(card)).toBe(expected);
  });
});

describe("field extraction", () => {
  it("reads the New Pairs card for The Rogue AI exactly", () => {
    const rogue = result.observations.find(
      (o) => o.mint === "1TGF97nuz88QXET6KjnC6JK3ZuS27FJvPtTvEZEq2BH",
    )!;
    expect(rogue).toBeDefined();
    expect(rogue.name).toBe("The Rogue AI");
    expect(rogue.symbol).toBe("RogueGPT");
    expect(rogue.marketCapUsd).toBe(3170);
    expect(rogue.volumeUsd).toBe(66);
    expect(rogue.ageSeconds).toBe(1);
    expect(rogue.source).toBe("new-pairs");
    expect(rogue.imageUrl).toBe(
      "https://axiomtrading-v2.axiom-cdn.io/1TGF97nuz88QXET6KjnC6JK3ZuS27FJvPtTvEZEq2BH.webp",
    );
    expect(rogue.seenAt).toBe(NOW);
  });

  it("reads a migrated card carrying a second token image", () => {
    // The Boring Company also renders a WBTC icon. Picking "the first img" or
    // "the first CDN img" would attribute the wrong image to the coin, and in
    // phase 4 that becomes the wrong perceptual hash.
    const tbc = result.observations.find(
      (o) => o.mint === "BQkGdvVHVNjArFSJCP2Xfw3priqwGiEK8grrWBXTGUrK",
    )!;
    expect(tbc.name).toBe("The Boring Company");
    expect(tbc.symbol).toBe("TBC");
    expect(tbc.imageUrl).toContain("BQkGdvVHVNjArFSJCP2Xfw3priqwGiEK8grrWBXTGUrK");
    expect(tbc.imageUrl).not.toContain("digitaloceanspaces");
  });

  it("reads the age past a countdown rather than stopping at it", () => {
    // The Boring Company renders `4m` then a `0:31` countdown. A fixed index
    // would have taken the countdown.
    const tbc = result.observations.find(
      (o) => o.mint === "BQkGdvVHVNjArFSJCP2Xfw3priqwGiEK8grrWBXTGUrK",
    )!;
    expect(tbc.ageSeconds).toBe(240);
  });

  it("handles a coin whose name and ticker are identical", () => {
    const poorcat = result.observations.find(
      (o) => o.mint === "2EzeRqTU5dkpaFVFqhz6auhgFYZMVpkmH8Gfm4Bapump",
    )!;
    expect(poorcat.symbol).toBe("POORCAT");
    expect(poorcat.name).toBe("POORCAT");
    expect(poorcat.ageSeconds).toBe(15);
  });

  it("never stores a data: image source", () => {
    // Every card carries a base64 placeholder alongside the real image. A data
    // URI cannot be fetched from the service worker and would mean storing
    // image bytes, which the storage budget rules out.
    for (const observation of result.observations) {
      expect(observation.imageUrl ?? "").not.toMatch(/^data:/);
    }
  });

  it("refuses the subscript fee rather than reading it as a plain number", () => {
    // The Rogue AI's fee renders as `0.0<sub>5</sub>4`. Flattened by
    // textContent that is "0.054" — a believable number, wrong by five orders
    // of magnitude. Nothing in a PairObservation may come from that token.
    const card = findCards(doc).find(
      (c) => c.getAttribute("data-pulse-token-address") === "1TGF97nuz88QXET6KjnC6JK3ZuS27FJvPtTvEZEq2BH",
    )!;
    expect(card.querySelectorAll("sub").length).toBeGreaterThan(0);
    const raw = readCard(card);
    expect(raw.marketCap).toBe("$3.17K");
    expect(raw.volume).toBe("$66");
  });
});

describe("the pass as a whole", () => {
  it("keeps every card and drops none", () => {
    expect(result.report.rows).toBe(30);
    expect(result.report.kept).toBe(30);
    expect(result.report.rejected["no-mint"]).toBe(0);
    expect(result.report.rejected["mint-mismatch"]).toBe(0);
  });

  it("extracts every field on every card", () => {
    // The metric the spec says to judge this phase on. These are exact: a drift
    // in any of them is the earliest warning that Axiom has moved something.
    expect(result.report.rates.name).toBe(1);
    expect(result.report.rates.symbol).toBe(1);
    expect(result.report.rates.imageUrl).toBe(1);
    expect(result.report.rates.marketCapUsd).toBe(1);
    expect(result.report.rates.volumeUsd).toBe(1);
    expect(result.report.rates.ageSeconds).toBe(1);
  });

  it("reports metadataUri as absent, because Pulse does not expose one", () => {
    // Not a failure. It means the identical-URI shortcut never fires from this
    // surface, and the image URL is the proxy phase 4 uses instead.
    expect(result.report.rates.metadataUri).toBe(0);
    expect(result.diagnosis.failing).not.toContain("metadataUri");
  });

  it("judges itself healthy", () => {
    expect(result.diagnosis.health).toBe("ok");
  });

  it("returns one observation per distinct mint", () => {
    const mints = result.observations.map((o) => o.mint);
    expect(new Set(mints).size).toBe(mints.length);
    expect(result.observations).toHaveLength(30);
  });

  it("honours a visibility gate", () => {
    // IntersectionObserver drives this in the page: only rows actually on
    // screen are worth hashing images and running lookups for.
    const gated = scrape(doc, {
      now: NOW,
      isVisible: (card) => columnOf(card) === "migrated",
    });
    expect(gated.observations).toHaveLength(12);
    expect(gated.observations.every((o) => o.source === "migrated")).toBe(true);
  });

  it("survives a card that throws, without losing the rest", () => {
    const dom = new JSDOM(readFileSync(FIXTURE, "utf8"), { url: "https://axiom.trade/pulse" });
    const hostile = dom.window.document;
    const card = hostile.querySelector("[data-pulse-token-address]")!;
    Object.defineProperty(card, "querySelectorAll", {
      value: () => {
        throw new Error("simulated redesign");
      },
    });

    const survived = scrape(hostile, { now: NOW });
    expect(survived.observations.length).toBeGreaterThanOrEqual(29);
    expect(survived.report.rows).toBe(30);
  });

  it("reports an empty page as cold rather than broken", () => {
    const empty = new JSDOM("<!DOCTYPE html><html><body></body></html>").window.document;
    const nothing = scrape(empty, { now: NOW });
    expect(nothing.observations).toEqual([]);
    expect(nothing.diagnosis.health).toBe("cold");
  });
});

describe("label variants", () => {
  /**
   * Build a minimal card with the figures rendered a given way.
   *
   * These are synthetic on purpose. The committed capture shows one rendering;
   * a live page showed another, and the point of these is that neither is
   * assumed to be the only one.
   */
  const cardWith = (inner: string): Element => {
    const d = new JSDOM(
      `<!DOCTYPE html><html><body><section><div>New Pairs</div>` +
        `<div data-pulse-token-address="1TGF97nuz88QXET6KjnC6JK3ZuS27FJvPtTvEZEq2BH">` +
        `${inner}<span>1TGF...q2BH</span><div>RogueGPT</div><div>The Rogue AI</div>` +
        `<span>9m</span></div></section></body></html>`,
      { url: "https://axiom.trade/pulse" },
    ).window.document;
    return d.querySelector("[data-pulse-token-address]")!;
  };

  it("reads the split rendering the capture uses", () => {
    const raw = readCard(cardWith("<span>V</span><span>$66</span><span>MC</span><span>$3.17K</span>"));
    expect(raw.volume).toBe("$66");
    expect(raw.marketCap).toBe("$3.17K");
  });

  it("reads a merged rendering, where label and value share a node", () => {
    // The failure that took live extraction to 0% while mints stayed at 100%.
    const raw = readCard(cardWith("<span>V $66</span><span>MC $3.17K</span>"));
    expect(raw.volume).toBe("$66");
    expect(raw.marketCap).toBe("$3.17K");
  });

  it("tolerates a non-breaking space between label and value", () => {
    const raw = readCard(cardWith("<span>V $66</span><span>MC $3.17K</span>"));
    expect(raw.volume).toBe("$66");
    expect(raw.marketCap).toBe("$3.17K");
  });

  it("tolerates case and a trailing colon", () => {
    const raw = readCard(cardWith("<span>Vol:</span><span>$66</span><span>mcap:</span><span>$3.17K</span>"));
    expect(raw.volume).toBe("$66");
    expect(raw.marketCap).toBe("$3.17K");
  });

  it("accepts the long labels a redesign might switch to", () => {
    const raw = readCard(cardWith("<span>Volume</span><span>$66</span><span>Market Cap</span><span>$3.17K</span>"));
    expect(raw.volume).toBe("$66");
    expect(raw.marketCap).toBe("$3.17K");
  });

  it("does not mistake a coin name beginning with V for a volume label", () => {
    // `V` is a one-letter label and a prefix of plenty of real words. Only the
    // money-shape check stands between it and nonsense.
    const raw = readCard(cardWith("<span>VICTORY</span><span>MC</span><span>$3.17K</span>"));
    expect(raw.volume).toBeNull();
    expect(raw.marketCap).toBe("$3.17K");
  });

  it("returns null rather than a wrong number for a subscript value", () => {
    const raw = readCard(cardWith("<span>MC</span><span>0.0<sub>5</sub>4</span>"));
    expect(raw.marketCap).toBeNull();
  });
});

describe("describeCard", () => {
  it("reports tokens and resolved fields for diagnosis", () => {
    // What the extension prints to the console when it notices it is degraded,
    // so a live disagreement with the fixture can be read rather than guessed.
    const card = findCards(doc)[0]!;
    const described = describeCard(card);
    expect(described.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(described.tokens).toContain("MC");
    expect(described.fields.marketCap).toBe("$3.17K");
  });
});

describe("the live rendering that split the currency symbol", () => {
  /**
   * Reproduced verbatim from a degraded live run on 2026-09-20.
   *
   * Mints resolved on 24/24 rows while marketCapUsd and volumeUsd sat at 0%.
   * The committed capture renders a figure as `["MC", "$3.17K"]`; this build
   * renders it as `["MC", "$", "3.05K"]`, and percentages split the same way.
   * Nothing in the fixture could have predicted it, which is the argument for
   * keeping a real degraded token stream as a test rather than a note.
   */
  const liveCard = (): Element => {
    const d = new JSDOM(
      `<!DOCTYPE html><html><body><section><div>New Pairs</div>` +
        `<div data-pulse-token-address="8NsUuh5UqWsTttyaCW4wZaZ913xupQbu4fBk3boG5Sj2">` +
        `<span>0.03</span><span>SOL</span><span>0.03</span><span>SOL</span>` +
        `<span>V</span><span>$</span><span>0</span>` +
        `<span>MC</span><span>$</span><span>3.05K</span>` +
        `<span>F</span><span>0</span><span>TX</span><span>1</span><span>348</span>` +
        `<span>8NsU...5Sj2</span><div>REBORN</div><div>Zerebr0 Reborn</div>` +
        `<span>14s</span><span>0</span><span>0</span>` +
        `<span>0</span><span>%</span><span>0%</span></div></section></body></html>`,
      { url: "https://axiom.trade/pulse" },
    ).window.document;
    return d.querySelector("[data-pulse-token-address]")!;
  };

  it("reads a figure split across currency symbol and magnitude", () => {
    const raw = readCard(liveCard());
    expect(raw.marketCap).toBe("$3.05K");
    expect(raw.volume).toBe("$0");
  });

  it("produces a complete observation from it", () => {
    const { observation } = toObservation(readCard(liveCard()), "new-pairs", NOW);
    expect(observation!.marketCapUsd).toBe(3050);
    // Zero is a real volume, and must survive as 0 rather than collapsing to
    // null — the tally counts a null as a failed extraction.
    expect(observation!.volumeUsd).toBe(0);
    expect(observation!.name).toBe("Zerebr0 Reborn");
    expect(observation!.symbol).toBe("REBORN");
    expect(observation!.ageSeconds).toBe(14);
  });

  it("keeps the magnitude when the number itself is split", () => {
    // The trap in the obvious fix. Taking the first valid join reads
    // ["$", "3.05", "K"] as $3.05 and drops the K — a thousandfold error, in
    // the field that decides whether a coin counts as having run.
    const d = new JSDOM(
      `<!DOCTYPE html><html><body><section><div>New Pairs</div>` +
        `<div data-pulse-token-address="8NsUuh5UqWsTttyaCW4wZaZ913xupQbu4fBk3boG5Sj2">` +
        `<span>MC</span><span>$</span><span>3.05</span><span>K</span>` +
        `<span>8NsU...5Sj2</span><div>REBORN</div><div>Reborn</div><span>14s</span>` +
        `</div></section></body></html>`,
      { url: "https://axiom.trade/pulse" },
    ).window.document;
    const raw = readCard(d.querySelector("[data-pulse-token-address]")!);
    expect(raw.marketCap).toBe("$3.05K");
  });

  it("reads an age split into number and unit", () => {
    const d = new JSDOM(
      `<!DOCTYPE html><html><body><section><div>New Pairs</div>` +
        `<div data-pulse-token-address="8NsUuh5UqWsTttyaCW4wZaZ913xupQbu4fBk3boG5Sj2">` +
        `<span>8NsU...5Sj2</span><div>REBORN</div><div>Reborn</div>` +
        `<span>14</span><span>s</span></div></section></body></html>`,
      { url: "https://axiom.trade/pulse" },
    ).window.document;
    const raw = readCard(d.querySelector("[data-pulse-token-address]")!);
    expect(raw.age).toBe("14s");
  });

  it("does not fuse a neighbouring count onto the age", () => {
    // `1` then `5s` must not become `15s`. The age join is restricted to an
    // exact digits-then-unit pair for this reason.
    const d = new JSDOM(
      `<!DOCTYPE html><html><body><section><div>New Pairs</div>` +
        `<div data-pulse-token-address="8NsUuh5UqWsTttyaCW4wZaZ913xupQbu4fBk3boG5Sj2">` +
        `<span>8NsU...5Sj2</span><div>REBORN</div><div>Reborn</div>` +
        `<span>1</span><span>5s</span></div></section></body></html>`,
      { url: "https://axiom.trade/pulse" },
    ).window.document;
    const raw = readCard(d.querySelector("[data-pulse-token-address]")!);
    expect(raw.age).toBe("5s");
  });
});
