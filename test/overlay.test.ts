/**
 * The badge layer.
 *
 * The behavioural tests here are all versions of one rule — the page's DOM is
 * never touched — plus the honest-zero rendering, which is the thing most
 * likely to be "simplified" into a plain 0 by someone who has not read why.
 */
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";
import { Overlay, formatAge, formatUsd, renderBadge, renderPopover } from "../src/content/overlay.js";
import type { LookupResult, PriorRun } from "../src/worker/lookup.js";

const DAY = 24 * 60 * 60 * 1000;
const MINT = "AtbSvZug8WZM4AuDb9MYryXbr3okXrk8BZGGCwvqpump";

let dom: JSDOM;
let doc: Document;

beforeEach(() => {
  dom = new JSDOM(
    `<!DOCTYPE html><html><body><div id="feed"><div id="card">a card</div></div></body></html>`,
    { url: "https://axiom.trade/pulse", pretendToBeVisual: true },
  );
  doc = dom.window.document;
});

/**
 * Give an element a non-zero layout box.
 *
 * jsdom performs no layout, so every `getBoundingClientRect()` returns zeros —
 * and the overlay deliberately skips a zero-size rect, because a recycled or
 * scrolled-away card reports one and painting there puts a badge over an
 * unrelated row. Without this stub no badge is ever created, which is how the
 * first draft of these tests managed to assert a great deal about badges
 * without any badge existing.
 */
const giveRect = (el: Element, top = 100): void => {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 10, y: top, left: 10, top, right: 310, bottom: top + 80,
      width: 300, height: 80, toJSON: () => ({}),
    }),
  });
};

const badgeCount = (): number =>
  doc.getElementById("rancheck-overlay")!.shadowRoot!.querySelectorAll(".badge").length;

const prior = (overrides: Partial<PriorRun> = {}): PriorRun => ({
  mint: MINT,
  name: "Thursday Arena",
  symbol: "THURSDAY",
  imageUrl: "https://cdn.example/a.webp",
  firstSeen: Date.UTC(2026, 8, 17),
  lastSeen: Date.UTC(2026, 8, 18),
  peakMcUsd: 250_000,
  ran: true,
  evidence: "market-cap",
  similarity: 1,
  matchedOn: ["name"],
  imageDistance: null,
  ...overrides,
});

const result = (overrides: Partial<LookupResult> = {}): LookupResult => ({
  mint: MINT,
  ranCount: 3,
  totalCount: 47,
  capped: false,
  confident: true,
  corpusAgeMs: 10 * DAY,
  priors: [prior()],
  ...overrides,
});

describe("renderBadge", () => {
  it("shows runs first and total second", () => {
    const host = doc.createElement("div");
    host.append(...renderBadge(doc, result()));
    expect(host.textContent).toBe("3/ 47");
    expect(host.querySelector(".ran")!.textContent).toBe("3");
  });

  it("shows corpus age instead of a number when too young to interpret", () => {
    // The failure this prevents: a 0 on a three-day corpus reads as "never been
    // run" when it means "we started watching on Tuesday".
    const host = doc.createElement("div");
    host.append(...renderBadge(doc, result({ confident: false, corpusAgeMs: 2 * DAY })));
    expect(host.textContent).toContain("new corpus");
    expect(host.textContent).not.toMatch(/\b0\b/);
    expect(host.querySelector(".cold")).not.toBeNull();
  });

  it("marks a capped total as a floor", () => {
    const host = doc.createElement("div");
    host.append(...renderBadge(doc, result({ capped: true })));
    expect(host.textContent).toContain("/ 47+");
  });
});

describe("renderPopover", () => {
  it("always states the corpus age", () => {
    const popover = renderPopover(doc, result());
    expect(popover.querySelector(".age")!.textContent).toContain("10 days");
  });

  it("always states the undercount, not just once", () => {
    // Structural, not a caveat that stops being true after it has been read.
    const popover = renderPopover(doc, result());
    expect(popover.querySelector(".caveat")!.textContent).toContain("while the tab was shut");
  });

  it("links each prior run to Axiom by mint", () => {
    const link = renderPopover(doc, result()).querySelector("a")!;
    expect(link.getAttribute("href")).toBe(`https://axiom.trade/meme/${MINT}`);
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("lists first-seen date, peak market cap and why it counts as a run", () => {
    const meta = renderPopover(doc, result()).querySelector(".meta")!.textContent ?? "";
    expect(meta).toContain("first seen 2026-09-17");
    expect(meta).toContain("peak MC $250.0K");
    expect(meta).toContain("ran — peak MC");
  });

  it("says a migrated run was migrated", () => {
    const popover = renderPopover(doc, result({ priors: [prior({ evidence: "migrated" })] }));
    expect(popover.querySelector(".meta")!.textContent).toContain("ran — migrated");
  });

  it("describes matchedOn as recognition, not equality", () => {
    // The port's comment is explicit: matchedOn means "this is what was
    // recognisable", never "these fields are identical".
    const meta = renderPopover(doc, result()).querySelector(".meta")!.textContent ?? "";
    expect(meta).toContain("recognised by name");
  });

  it("puts runs above dead deployments", () => {
    const popover = renderPopover(
      doc,
      result({
        priors: [
          prior({ mint: "dead", ran: false, evidence: "none", peakMcUsd: 900 }),
          prior({ mint: "ran", ran: true, peakMcUsd: 400_000 }),
        ],
      }),
    );
    const links = [...popover.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links[0]).toContain("ran");
  });

  it("says plainly when nothing has been seen before", () => {
    const popover = renderPopover(doc, result({ ranCount: 0, totalCount: 0, priors: [] }));
    expect(popover.querySelector(".empty")!.textContent).toContain("No prior deployment");
  });
});

describe("Overlay", () => {
  it("never writes into the page's own DOM", () => {
    // The rule the whole file exists for. React deletes anything injected into
    // its tree, and if it does not, the row height changes and the virtualiser's
    // cached measurements break.
    const card = doc.getElementById("card")!;
    giveRect(card);
    const before = card.outerHTML;
    const feedBefore = doc.getElementById("feed")!.children.length;

    const overlay = new Overlay(doc);
    overlay.setTargets([{ mint: MINT, card, result: result() }]);
    overlay.flush();

    // The badge exists, and the card is untouched. Both halves matter: without
    // the first this asserts nothing.
    expect(badgeCount()).toBe(1);
    expect(card.outerHTML).toBe(before);
    expect(doc.getElementById("feed")!.children.length).toBe(feedBefore);
    overlay.destroy();
  });

  it("puts everything inside a shadow root on documentElement", () => {
    // Keeps Axiom's reset off the badge and the badge's styles off the feed.
    const overlay = new Overlay(doc);
    const host = doc.getElementById("rancheck-overlay")!;
    expect(host.parentElement).toBe(doc.documentElement);
    expect(host.shadowRoot).not.toBeNull();
    overlay.destroy();
  });

  it("replaces an overlay left behind by a previous injection", () => {
    // The content script can be injected twice on a SPA navigation, and two
    // stacked layers would double every badge.
    new Overlay(doc);
    new Overlay(doc);
    expect(doc.querySelectorAll("#rancheck-overlay")).toHaveLength(1);
  });

  it("drops a badge when its card has been recycled to another coin", () => {
    // The reported bug, and the worst failure this project has: a stale badge
    // sitting over a newly-inserted coin. New Pairs inserts at the top, every
    // row below shifts down, and a node that held coin A now holds coin B —
    // while the badge still says what it said about A. A wrong count is
    // indistinguishable from a right one, so the badge must vanish.
    const card = doc.getElementById("card")!;
    giveRect(card);
    card.setAttribute("data-pulse-token-address", MINT);

    const overlay = new Overlay(doc, {
      verifyMint: (el) => el.getAttribute("data-pulse-token-address"),
    });

    overlay.setTargets([{ mint: MINT, card, result: result() }]);
    overlay.flush();
    expect(badgeCount()).toBe(1);

    // The virtualiser reuses the node for a different coin.
    card.setAttribute("data-pulse-token-address", "SomeOtherMintEntirely111111111111111");
    overlay.flush();
    expect(badgeCount()).toBe(0);
    overlay.destroy();
  });

  it("keeps the badge when the card still holds the same coin", () => {
    const card = doc.getElementById("card")!;
    giveRect(card);
    card.setAttribute("data-pulse-token-address", MINT);

    const overlay = new Overlay(doc, {
      verifyMint: (el) => el.getAttribute("data-pulse-token-address"),
    });
    overlay.setTargets([{ mint: MINT, card, result: result() }]);
    overlay.flush();
    overlay.flush();

    expect(badgeCount()).toBe(1);
    overlay.destroy();
  });

  it("abstains rather than dropping when the mint cannot be read", () => {
    // The check may veto; it must never be the reason a good badge disappears.
    // A card whose attribute is missing is resolved by other means upstream,
    // and "cannot tell" is not "wrong card".
    const card = doc.getElementById("card")!;
    giveRect(card);
    const overlay = new Overlay(doc, { verifyMint: () => null });
    overlay.setTargets([{ mint: MINT, card, result: result() }]);
    overlay.flush();

    expect(badgeCount()).toBe(1);
    overlay.destroy();
  });

  it("repositions without touching the worker or the page", () => {
    // reposition() is the cheap path: rects and styles only. It is driven from
    // the MutationObserver so badges track rows frame by frame while scraping
    // stays debounced.
    const card = doc.getElementById("card")!;
    giveRect(card);
    const before = card.outerHTML;
    const overlay = new Overlay(doc);
    overlay.setTargets([{ mint: MINT, card, result: result() }]);
    overlay.flush();
    overlay.flush();
    expect(badgeCount()).toBe(1);
    expect(card.outerHTML).toBe(before);
    overlay.destroy();
  });

  it("drops a badge whose card has left the DOM", () => {
    // Virtualised lists recycle nodes. A badge outliving its card would be
    // painted over an unrelated row — coin A's count on coin B.
    const card = doc.getElementById("card")!;
    giveRect(card);
    const overlay = new Overlay(doc);
    overlay.setTargets([{ mint: MINT, card, result: result() }]);
    overlay.flush();
    expect(badgeCount()).toBe(1);

    card.remove();
    overlay.setTargets([{ mint: MINT, card, result: result() }]);
    overlay.flush();
    expect(badgeCount()).toBe(0);
    overlay.destroy();
  });
});

describe("formatting", () => {
  it("formats market caps at readable magnitudes", () => {
    expect(formatUsd(250_000)).toBe("$250.0K");
    expect(formatUsd(1_110_000)).toBe("$1.11M");
    expect(formatUsd(819)).toBe("$819");
  });

  it("formats corpus age in units that match its meaning", () => {
    expect(formatAge(30 * 60 * 1000)).toBe("30 min");
    expect(formatAge(5 * 60 * 60 * 1000)).toBe("5 h");
    expect(formatAge(10 * DAY)).toBe("10 days");
  });
});
