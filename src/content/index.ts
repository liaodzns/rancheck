/**
 * The content script: scrape, record, badge.
 *
 * Phase 2 established the loop and deliberately shipped no UI, on the grounds
 * that a badge painted from a scraper nobody has measured is a number nobody
 * should trust. That measurement has now happened — 100% field extraction
 * across a live session — so this phase hangs storage and a badge off the same
 * loop.
 *
 * The loop is shaped by two constraints that are easy to get wrong:
 *
 * **The feed is fast and the main thread is Axiom's.** New Pairs turns over at
 * ~31 launches a minute and the list is virtualised, so mutations are constant.
 * Observing `document` with an unfiltered `subtree: true` would fire on every
 * price tick on the page. The observer is scoped to the columns and debounced,
 * and an extension that makes the feed janky does not get used however good its
 * numbers are.
 *
 * **Nothing may be cached on a DOM node.** Virtualised lists recycle elements:
 * the div that held coin A holds coin B a second later. Every pass therefore
 * re-derives everything from scratch and keys by mint. There is no node state
 * here, and there must never be.
 */
import { scrape } from "./scrape.js";
import { SELECTORS, describeCard, mintAttrOf, mintOf } from "./selectors.js";
import { Overlay, type BadgeTarget } from "./overlay.js";
import type { PairObservation } from "../shared/types.js";
import type { Request, Response } from "../shared/messages.js";

/**
 * Debounce for the mutation-driven pass.
 *
 * The spec's number. Long enough that a burst of virtualiser churn collapses
 * into one pass, short enough that a coin is seen while it is still on screen.
 */
const DEBOUNCE_MS = 250;

/**
 * Backstop interval.
 *
 * A MutationObserver can miss a state we care about — a scroll that only
 * repositions existing nodes, a column that re-renders without structural
 * change, a tab restored from bfcache. The reconcile pass costs one scrape of
 * whatever is on screen and removes a whole class of "it stopped working and
 * nobody noticed".
 */
const RECONCILE_MS = 5_000;

/** How often to print the extraction report. Rates matter; per-pass noise does not. */
const REPORT_MS = 30_000;

const log = (...args: unknown[]): void => console.log("%c[rancheck]", "color:#5DBCFF", ...args);

/**
 * Rows currently intersecting the viewport.
 *
 * Membership is by element, which looks like it contradicts the no-node-state
 * rule above but does not: this set is only ever read within a single pass to
 * decide whether a card is worth the expensive work, and a recycled node being
 * briefly wrong costs one skipped or one extra row, never a wrong badge. It is
 * rebuilt continuously by the observer and never consulted across passes.
 */
const visible = new WeakSet<Element>();

let intersection: IntersectionObserver | null = null;

function observeVisibility(root: ParentNode): void {
  intersection?.disconnect();
  intersection = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
    },
    // A little margin, so a row is hashed just before it scrolls into view
    // rather than just after.
    { rootMargin: "200px" },
  );
  for (const card of root.querySelectorAll(SELECTORS.card)) intersection.observe(card);
}

let lastReportAt = 0;
let overlay: Overlay | null = null;

const createOverlay = (): Overlay => new Overlay(document, { verifyMint: mintAttrOf });

/**
 * Talk to the service worker.
 *
 * Resolves to null rather than throwing when the worker is unreachable. MV3
 * evicts it constantly and a message sent into the gap between eviction and
 * restart fails normally — the next pass is 250ms away, so a dropped lookup
 * costs one frame of a missing badge and nothing else. Throwing here would
 * take down the observer loop for a condition that is expected by design.
 */
async function ask(request: Request): Promise<Response | null> {
  try {
    return (await chrome.runtime.sendMessage(request)) as Response;
  } catch {
    return null;
  }
}

/**
 * Record what was seen, then ask what it matches, then paint.
 *
 * Observe before lookup, and deliberately: the subject's own mint is excluded
 * from its candidates, so writing first cannot make a coin match itself, and it
 * means a coin seen twice in one session is already stored when the second
 * sighting asks about it.
 */
async function resolveBadges(observations: readonly PairObservation[]): Promise<void> {
  if (observations.length === 0) return;

  await ask({ type: "observe", observations: [...observations] });

  const response = await ask({
    type: "lookup",
    subjects: observations.map((o) => ({ mint: o.mint, name: o.name, symbol: o.symbol })),
  });
  if (response === null || response.type !== "looked-up") return;

  // Node bindings are re-derived here rather than carried from the scrape,
  // because between the scrape and this line the virtualiser may have recycled
  // every card on screen. Keying by mint is what makes that safe.
  const cards = new Map<string, Element>();
  for (const card of document.querySelectorAll(SELECTORS.card)) {
    const mint = mintOf(card);
    if (mint !== null) cards.set(mint, card);
  }

  const targets: BadgeTarget[] = [];
  for (const result of response.results) {
    const card = cards.get(result.mint);
    if (card === undefined) continue;
    targets.push({ mint: result.mint, card, result });
  }

  overlay ??= createOverlay();
  overlay.setTargets(targets);
}

function pass(reason: string): void {
  const started = performance.now();
  const result = scrape(document, { isVisible: (card) => visible.has(card) });
  const elapsed = performance.now() - started;

  // Re-observe: the virtualiser will have created cards this observer has never
  // seen. Cheap, and the alternative is rows that are never marked visible.
  observeVisibility(document);

  if (result.observations.length > 0) {
    log(
      `${reason}: ${result.observations.length} pairs in ${elapsed.toFixed(1)}ms`,
      summarise(result.observations),
    );
    void resolveBadges(result.observations);
  }

  const now = Date.now();
  if (now - lastReportAt > REPORT_MS) {
    lastReportAt = now;
    log("extraction", result.report, result.diagnosis.message);
    void reportCorpus();
    if (result.diagnosis.health === "fields-failing" || result.diagnosis.health === "mints-failing") {
      console.warn("[rancheck] scraper is degraded:", result.diagnosis.message);
      dumpFirstCard();
    }
  }
}

/**
 * Print how large the corpus is and how long it has been watching.
 *
 * Without this, a screen full of `0 / 0` is ambiguous in a way that matters
 * while the corpus is young: it means either "nothing here has been deployed
 * before" or "nothing is being stored at all", and those need opposite
 * responses. A growing coin count distinguishes them in one line.
 */
async function reportCorpus(): Promise<void> {
  const response = await ask({ type: "meta" });
  if (response === null || response.type !== "meta") return;
  log(
    `corpus: ${response.meta.coinCount} coins, watching ${Math.round(response.ageMs / 1000)}s`,
  );
}

/**
 * Print one card's innards when extraction is failing.
 *
 * A degraded scraper means the committed fixture and the live page disagree,
 * and the fixture cannot say how. Printing it automatically beats asking
 * someone to paste a console snippet: the isolated world a content script runs
 * in is not the console's default context, so `window.__rancheck` would not
 * even be reachable without switching the context dropdown first.
 *
 * One card, tokens and resolved fields only. Enough to see which assumption
 * broke; nothing that identifies whoever is running it.
 */
function dumpFirstCard(): void {
  const card = document.querySelector(SELECTORS.card);
  if (card === null) return;
  console.warn(
    "[rancheck] first card, for diagnosis — paste this into the issue:",
    JSON.stringify(describeCard(card), null, 2),
  );
}

/** A compact console view. The full objects are one expand away in devtools. */
function summarise(observations: readonly PairObservation[]): string {
  return observations
    .slice(0, 5)
    .map((o) => `${o.symbol ?? "?"}@${o.source}`)
    .join(" ");
}

let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(reason: string): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      pass(reason);
    } catch (error) {
      // The loop outliving a bad pass is the whole point. A throw here would
      // stop the extension permanently and silently.
      console.warn("[rancheck] pass failed:", error);
    }
  }, DEBOUNCE_MS);
}

function start(): void {
  const columns = [...document.querySelectorAll(SELECTORS.column)].filter(
    (section) => section.querySelector(SELECTORS.card) !== null,
  );

  if (columns.length === 0) {
    // Axiom is a single-page app and the content script runs before the feed
    // renders. Watch for it rather than giving up.
    const bootstrap = new MutationObserver(() => {
      if (document.querySelector(SELECTORS.card) !== null) {
        bootstrap.disconnect();
        start();
      }
    });
    bootstrap.observe(document.body, { childList: true, subtree: true });
    log("waiting for the feed to render");
    return;
  }

  log(`watching ${columns.length} columns`);

  overlay ??= createOverlay();

  const observer = new MutationObserver(() => {
    // Two different cadences on purpose. Repositioning is a rect read and a
    // style write, so it runs immediately (rAF-throttled) and keeps badges
    // pinned to their rows as the feed inserts above them. Scraping and the
    // worker round-trip are expensive, so they stay debounced.
    //
    // Speeding the debounce up instead would have narrowed the window without
    // closing it, and spent main-thread time on a feed that is already busy.
    overlay?.reposition();
    schedule("mutation");
  });
  for (const column of columns) {
    observer.observe(column, { childList: true, subtree: true, characterData: true });
  }

  // A column changing size moves every row in it without a scroll or a
  // mutation — a window resize, a panel opening, the layout reflowing.
  const resize = new ResizeObserver(() => overlay?.reposition());
  for (const column of columns) resize.observe(column);

  observeVisibility(document);
  setInterval(() => schedule("reconcile"), RECONCILE_MS);
  schedule("initial");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
