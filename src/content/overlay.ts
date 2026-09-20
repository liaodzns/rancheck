/**
 * The badge layer.
 *
 * ---------------------------------------------------------------------------
 * The rule this file exists to enforce: **never write inside a row.**
 *
 * Two things go wrong if you do. React owns that subtree and will delete
 * anything injected into it on the next render, so the badge flickers and
 * vanishes. And if it does not delete it, you have changed the row's height,
 * which breaks the virtualiser's cached measurements — the list then scrolls
 * to the wrong offsets and jumps under the cursor.
 *
 * So every badge lives in one fixed-position layer of our own, in a shadow
 * root, positioned against each card's `getBoundingClientRect()` and
 * reconciled on scroll. The page's DOM is never modified. An extension that
 * makes the feed janky does not get used, however good the number on it is.
 * ---------------------------------------------------------------------------
 *
 * The shadow root is also what keeps Axiom's stylesheet and ours apart, in both
 * directions: their Tailwind reset cannot restyle the badge, and nothing here
 * can leak out and restyle the feed.
 */
import type { LookupResult, PriorRun } from "../worker/lookup.js";
import { axiomLink } from "../shared/config.js";

const HOST_ID = "rancheck-overlay";

const STYLE = `
  :host { all: initial; }
  .layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483000;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .badge {
    position: absolute;
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
    color: #e8eaed;
    background: rgba(18, 20, 24, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.14);
    cursor: pointer;
    white-space: nowrap;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }
  .badge:hover { border-color: rgba(255, 255, 255, 0.34); }
  .ran { color: #5ee89b; }
  .total { color: #9aa0a6; font-weight: 500; }
  /* A corpus too young to interpret. Muted, and never a number. */
  .cold { color: #9aa0a6; font-weight: 500; font-style: italic; }
  .capped { color: #ffcc66; }

  .popover {
    position: absolute;
    pointer-events: auto;
    width: 320px;
    max-height: 420px;
    overflow-y: auto;
    padding: 10px 12px;
    border-radius: 10px;
    color: #e8eaed;
    background: rgba(14, 16, 20, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
    font-size: 12px;
  }
  .popover h3 { margin: 0 0 2px; font-size: 13px; }
  .age { margin: 0 0 8px; color: #9aa0a6; font-size: 11px; }
  .caveat { margin: 0 0 8px; color: #ffcc66; font-size: 11px; line-height: 1.45; }
  .prior { display: flex; gap: 8px; padding: 6px 0; border-top: 1px solid rgba(255,255,255,0.08); }
  .prior img { width: 32px; height: 32px; border-radius: 6px; object-fit: cover; background: #222; }
  .prior a { color: #5DBCFF; text-decoration: none; font-weight: 600; }
  .prior a:hover { text-decoration: underline; }
  .meta { color: #9aa0a6; font-size: 11px; }
  .empty { color: #9aa0a6; padding: 6px 0; }
`;

export interface BadgeTarget {
  mint: string;
  card: Element;
  result: LookupResult;
}

/**
 * One fixed layer, reconciled wholesale each frame it needs to move.
 *
 * Badges are keyed by mint rather than by node, because virtualised lists
 * recycle elements: the div that held coin A holds coin B a second later, and
 * anything remembered about a node is wrong within a second. The node bindings
 * are re-derived from scratch on every reconcile.
 */
export class Overlay {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly layer: HTMLElement;
  private readonly badges = new Map<string, HTMLElement>();
  private targets: BadgeTarget[] = [];
  private frame: number | null = null;
  private popover: HTMLElement | null = null;
  private openFor: string | null = null;

  private readonly verifyMint: ((card: Element) => string | null) | undefined;

  /**
   * `verifyMint` is injected rather than imported so this file keeps knowing
   * nothing about what an Axiom card looks like — every DOM assumption belongs
   * in `selectors.ts`, including the cheap one used here.
   */
  constructor(
    private readonly doc: Document = document,
    options: { verifyMint?: (card: Element) => string | null } = {},
  ) {
    this.verifyMint = options.verifyMint;

    const existing = doc.getElementById(HOST_ID);
    existing?.remove();

    this.host = doc.createElement("div");
    this.host.id = HOST_ID;
    this.root = this.host.attachShadow({ mode: "open" });

    const style = doc.createElement("style");
    style.textContent = STYLE;
    this.root.appendChild(style);

    this.layer = doc.createElement("div");
    this.layer.className = "layer";
    this.root.appendChild(this.layer);
    doc.documentElement.appendChild(this.host);

    // rAF-throttled: scroll fires far more often than the screen repaints, and
    // doing layout work per event is exactly how an overlay makes a feed feel
    // heavy.
    const onViewportChange = (): void => this.reposition();
    doc.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
    doc.defaultView?.addEventListener("resize", onViewportChange, { passive: true });
  }

  /** Replace the set of badges. Cheap to call on every pass. */
  setTargets(targets: readonly BadgeTarget[]): void {
    this.targets = [...targets];
    this.reposition();
  }

  /**
   * Re-measure and re-place, without going anywhere near the worker.
   *
   * Public and deliberately cheap, because position goes stale far faster than
   * data does. A new coin inserting at the top of New Pairs shifts every row
   * below it down by a row height, and that is a DOM mutation, not a scroll —
   * so nothing in the original listener set fired, and each badge sat at its
   * old pixel position, which by then belonged to the next coin down.
   *
   * The caller drives this from the same MutationObserver that schedules a full
   * pass, so repositioning tracks the feed frame by frame while the expensive
   * scrape-and-lookup stays debounced. rAF-throttling makes it self-regulating:
   * a still feed costs nothing.
   */
  reposition(): void {
    this.scheduleReconcile();
  }

  /**
   * Reconcile now, instead of on the next animation frame.
   *
   * Badge placement is normally deferred to rAF so a burst of scroll or
   * mutation events collapses into one layout pass. This forces it, which tests
   * need in order to assert on placement without racing a frame, and which is
   * occasionally right in the page when a badge must be correct before the next
   * paint rather than after it.
   */
  flush(): void {
    const view = this.doc.defaultView;
    if (this.frame !== null && view?.cancelAnimationFrame !== undefined) {
      view.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.reconcile();
  }

  private scheduleReconcile(): void {
    if (this.frame !== null) return;
    const raf = this.doc.defaultView?.requestAnimationFrame;
    if (raf === undefined) {
      this.reconcile();
      return;
    }
    this.frame = raf.call(this.doc.defaultView, () => {
      this.frame = null;
      this.reconcile();
    });
  }

  /**
   * Position every badge against its card's current rect.
   *
   * Reads every rect first and writes afterwards. Interleaving them would force
   * a layout flush per badge — the classic read/write thrash — and with forty
   * rows on screen that is forty synchronous layouts per frame.
   */
  private reconcile(): void {
    const seen = new Set<string>();
    const placements: Array<{ badge: HTMLElement; rect: DOMRect }> = [];

    for (const target of this.targets) {
      if (!target.card.isConnected) continue;

      // Does this node still hold the coin the badge is about?
      //
      // `target.card` is a node reference captured when the lookup returned,
      // and virtualised lists recycle nodes: the div that held coin A holds
      // coin B moments later. Without this check the badge stays put and its
      // number is silently reattributed to whatever coin moved in underneath —
      // which is the worst failure this project has, because a wrong count is
      // indistinguishable from a right one.
      //
      // `verifyMint` returning null means "cannot tell" and abstains, in
      // keeping with the rest of the codebase: a check like this may veto, but
      // must never be the reason a good badge disappears.
      const actual = this.verifyMint?.(target.card) ?? null;
      if (actual !== null && actual !== target.mint) continue;

      const rect = target.card.getBoundingClientRect();
      // A recycled or scrolled-away card reports a zero rect. Skipping keeps a
      // stale badge from being painted over an unrelated row.
      if (rect.width === 0 || rect.height === 0) continue;

      seen.add(target.mint);
      placements.push({ badge: this.badgeFor(target), rect });
    }

    for (const { badge, rect } of placements) {
      badge.style.left = `${Math.round(rect.left + 8)}px`;
      badge.style.top = `${Math.round(rect.top + 6)}px`;
    }

    for (const [mint, badge] of this.badges) {
      if (seen.has(mint)) continue;
      badge.remove();
      this.badges.delete(mint);
      if (this.openFor === mint) this.closePopover();
    }
  }

  private badgeFor(target: BadgeTarget): HTMLElement {
    let badge = this.badges.get(target.mint);
    if (badge === undefined) {
      badge = this.doc.createElement("div");
      badge.className = "badge";
      badge.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        this.togglePopover(target);
      });
      this.layer.appendChild(badge);
      this.badges.set(target.mint, badge);
    }
    badge.replaceChildren(...renderBadge(this.doc, target.result));
    badge.title = badgeTitle(target.result);
    return badge;
  }

  private togglePopover(target: BadgeTarget): void {
    if (this.openFor === target.mint) {
      this.closePopover();
      return;
    }
    this.closePopover();

    const popover = renderPopover(this.doc, target.result);
    const rect = target.card.getBoundingClientRect();
    popover.style.left = `${Math.round(Math.min(rect.left + 8, this.viewportWidth() - 332))}px`;
    popover.style.top = `${Math.round(rect.top + 28)}px`;
    this.layer.appendChild(popover);

    this.popover = popover;
    this.openFor = target.mint;
  }

  private viewportWidth(): number {
    return this.doc.defaultView?.innerWidth ?? 1280;
  }

  closePopover(): void {
    this.popover?.remove();
    this.popover = null;
    this.openFor = null;
  }

  destroy(): void {
    this.host.remove();
    this.badges.clear();
  }
}

/**
 * The badge contents.
 *
 * `3 / 47` — runs first because that is the number the decision turns on, total
 * second and muted because it is context. On a corpus too young to interpret,
 * no number at all: a `0` there would be read as "never been run" when it means
 * "we started watching on Tuesday".
 */
export function renderBadge(doc: Document, result: LookupResult): Node[] {
  if (!result.confident) {
    const cold = doc.createElement("span");
    cold.className = "cold";
    cold.textContent = `new corpus · ${formatAge(result.corpusAgeMs)}`;
    return [cold];
  }

  const ran = doc.createElement("span");
  ran.className = "ran";
  ran.textContent = String(result.ranCount);

  const total = doc.createElement("span");
  total.className = "total";
  total.textContent = `/ ${result.totalCount}${result.capped ? "+" : ""}`;

  const nodes: Node[] = [ran, total];
  if (result.capped) {
    const capped = doc.createElement("span");
    capped.className = "capped";
    capped.textContent = "▲";
    nodes.push(capped);
  }
  return nodes;
}

function badgeTitle(result: LookupResult): string {
  if (!result.confident) {
    return `rancheck has only been watching for ${formatAge(result.corpusAgeMs)}. Too early for a count to mean anything.`;
  }
  const base = `${result.ranCount} of ${result.totalCount} prior deployments cleared the run bar`;
  return result.capped
    ? `${base} (capped — a very large cluster; the real total is higher)`
    : `${base}. A floor: only what this browser saw.`;
}

/**
 * The popover: what the prior runs actually were.
 *
 * Corpus age is in the header, always and unconditionally, because every number
 * below it is meaningless without it.
 */
export function renderPopover(doc: Document, result: LookupResult): HTMLElement {
  const popover = doc.createElement("div");
  popover.className = "popover";

  const heading = doc.createElement("h3");
  heading.textContent = result.confident
    ? `${result.ranCount} ran of ${result.totalCount} seen`
    : "Not enough corpus yet";
  popover.appendChild(heading);

  const age = doc.createElement("p");
  age.className = "age";
  age.textContent =
    result.corpusAgeMs === 0
      ? "Corpus is empty — nothing has been recorded yet."
      : `Watching for ${formatAge(result.corpusAgeMs)}.`;
  popover.appendChild(age);

  // Said every time, not once. The undercount is structural, not a caveat that
  // stops being true after the user has read it.
  const caveat = doc.createElement("p");
  caveat.className = "caveat";
  caveat.textContent =
    "Counts only what this browser saw. A coin that ran while the tab was shut is counted as a deployment, not a run.";
  popover.appendChild(caveat);

  if (result.capped) {
    const capped = doc.createElement("p");
    capped.className = "caveat";
    capped.textContent = "Candidate list was capped — this cluster is larger than shown.";
    popover.appendChild(capped);
  }

  if (result.priors.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "empty";
    empty.textContent = "No prior deployment of this name or ticker has been seen.";
    popover.appendChild(empty);
    return popover;
  }

  // Runs first: they are what the decision turns on, and a long tail of dead
  // deployments below them is context rather than something to scroll past.
  const ordered = [...result.priors].sort(
    (a, b) => Number(b.ran) - Number(a.ran) || (b.peakMcUsd ?? 0) - (a.peakMcUsd ?? 0),
  );
  for (const prior of ordered.slice(0, 50)) {
    popover.appendChild(renderPrior(doc, prior));
  }

  return popover;
}

function renderPrior(doc: Document, prior: PriorRun): HTMLElement {
  const row = doc.createElement("div");
  row.className = "prior";

  if (prior.imageUrl !== null) {
    const img = doc.createElement("img");
    img.src = prior.imageUrl;
    img.alt = "";
    img.loading = "lazy";
    row.appendChild(img);
  }

  const body = doc.createElement("div");

  const link = doc.createElement("a");
  link.href = axiomLink(prior.mint);
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.textContent = prior.symbol ?? prior.name ?? prior.mint.slice(0, 8);
  body.appendChild(link);

  const meta = doc.createElement("div");
  meta.className = "meta";
  meta.textContent = [
    prior.name ?? "(no name)",
    `first seen ${formatDate(prior.firstSeen)}`,
    prior.peakMcUsd === null ? "peak MC unknown" : `peak MC ${formatUsd(prior.peakMcUsd)}`,
    describeRun(prior),
    // "what was recognisable", never "these fields are equal" — the port's
    // comment is explicit that matchedOn means the former.
    `recognised by ${prior.matchedOn.join(" + ")}`,
  ].join(" · ");
  body.appendChild(meta);

  row.appendChild(body);
  return row;
}

function describeRun(prior: PriorRun): string {
  switch (prior.evidence) {
    case "migrated":
      return "ran — migrated";
    case "market-cap":
      return "ran — peak MC";
    case "none":
      return "no run observed";
  }
}

export function formatUsd(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

export function formatAge(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
