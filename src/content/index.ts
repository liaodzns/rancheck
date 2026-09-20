/**
 * The content script. Phase 2: it reads and it logs, and it does nothing else.
 *
 * No badges, no storage, no messages to a worker. The spec is explicit that
 * this phase ships no UI, and the reason is worth keeping in view: the scraper
 * is the fragile part, and the only way to know whether it works is to watch
 * its extraction rate over a few hundred real rows before anything depends on
 * it. A badge painted from a scraper nobody has measured is a number nobody
 * should trust.
 *
 * What it does do is establish the loop that later phases hang off, and that
 * loop is shaped by two constraints that are easy to get wrong:
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
import { SELECTORS, describeCard } from "./selectors.js";
import type { PairObservation } from "../shared/types.js";

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
  }

  const now = Date.now();
  if (now - lastReportAt > REPORT_MS) {
    lastReportAt = now;
    log("extraction", result.report, result.diagnosis.message);
    if (result.diagnosis.health === "fields-failing" || result.diagnosis.health === "mints-failing") {
      console.warn("[rancheck] scraper is degraded:", result.diagnosis.message);
      dumpFirstCard();
    }
  }
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

  const observer = new MutationObserver(() => schedule("mutation"));
  for (const column of columns) {
    observer.observe(column, { childList: true, subtree: true, characterData: true });
  }

  observeVisibility(document);
  setInterval(() => schedule("reconcile"), RECONCILE_MS);
  schedule("initial");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
