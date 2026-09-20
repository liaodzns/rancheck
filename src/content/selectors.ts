/**
 * Every DOM assumption this project makes, in one file.
 *
 * When Axiom redesigns, this is the file that breaks and the only one that
 * should need editing. Nothing outside it may query the page or know what an
 * Axiom card looks like.
 *
 * ---------------------------------------------------------------------------
 * A correction to the spec, from the captured DOM.
 *
 * The spec's first scraper rule is "anchor on the mint: find `a[href*='/meme/']`,
 * parse the mint out of the href, then walk up to the row". Measured against
 * `fixtures/axiom-dom/pulse-2026-09-19.html`, that does not work, and it fails
 * in the most expensive way: it appears to work.
 *
 * The capture has 15 `/meme/` anchors. Every one of them is in the ticker strip
 * along the top of the page. The three Pulse columns — New Pairs, Final Stretch
 * and Migrated — contain 30 cards between them and **not one anchor**. They are
 * divs with click handlers, which is what a React app usually does. A scraper
 * built on the spec's rule would return 15 plausible-looking rows drawn from a
 * price ticker, and the corpus would fill with coins that were never on the
 * feed at all.
 *
 * What the cards do carry is `data-pulse-token-address`, holding the full mint.
 * The reasoning behind the spec's rule still applies to it and is why it is
 * trustworthy: like the href, it is application instrumentation rather than
 * styling, it is the identity Axiom's own code keys on, and it cannot drift
 * without breaking the page. Class names are hashed Tailwind and change per
 * deploy; this does not.
 *
 * The mint is attested four independent ways on every card — the attribute, the
 * token image filename, a `pump.fun/coin/<mint>` link and an `x.com/search?q=`
 * link — so `mintOf()` falls back through them rather than trusting one.
 * ---------------------------------------------------------------------------
 */
import type { ObservationSource } from "../shared/types.js";
import type { RawRow } from "./observation.js";
import { isFullMint, parseMintFromHref } from "./parse.js";

/** The attribute carrying the full mint. The row anchor, and the primary key. */
export const MINT_ATTR = "data-pulse-token-address";

export const SELECTORS = {
  /** One Pulse card. Also the row: it contains every field we read. */
  card: `[${MINT_ATTR}]`,
  /** The column a card sits in. Determines `source`. */
  column: "section",
  /** Axiom's own token image CDN. The filename is the mint. */
  tokenImage: "img[src]",
  /** A launchpad link, carrying the mint again. Fallback only. */
  launchpadLink: 'a[href*="pump.fun/coin/"]',
  /**
   * Pair links. Present only in the ticker strip, never in a card — kept
   * documented so nobody reintroduces the spec's original rule by accident.
   */
  pairLink: 'a[href*="/meme/"]',
} as const;

/**
 * Column heading text to observation source.
 *
 * Matched against the heading Axiom renders, lowercased. A column we do not
 * recognise becomes `other` rather than being dropped: an unknown column is
 * still a real sighting of a real coin, and guessing it is `new-pairs` would
 * quietly corrupt the "did it run" signal that `migrated` feeds.
 */
const COLUMN_SOURCES: ReadonlyArray<readonly [string, ObservationSource]> = [
  ["new pairs", "new-pairs"],
  ["final stretch", "final-stretch"],
  ["migrated", "migrated"],
];

/** Every Pulse card under `root`, in document order. */
export function findCards(root: ParentNode): Element[] {
  return [...root.querySelectorAll(SELECTORS.card)];
}

/**
 * The full mint for a card, or null.
 *
 * Tries the attribute, then the token image filename, then a launchpad link.
 * Every source is validated as base58 before it is returned, so a redesign that
 * repurposes the attribute produces null rather than a corpus keyed on junk.
 */
export function mintOf(card: Element): string | null {
  const attr = card.getAttribute(MINT_ATTR)?.trim() ?? "";
  if (isFullMint(attr)) return attr;

  for (const img of card.querySelectorAll(SELECTORS.tokenImage)) {
    const candidate = mintFromImageSrc(img.getAttribute("src"));
    if (candidate !== null) return candidate;
  }

  const launchpad = card.querySelector(SELECTORS.launchpadLink)?.getAttribute("href") ?? null;
  const fromLaunchpad = /\/coin\/([^/?#]+)/.exec(launchpad ?? "")?.[1] ?? null;
  if (fromLaunchpad !== null && isFullMint(fromLaunchpad)) return fromLaunchpad;

  return parseMintFromHref(card.querySelector(SELECTORS.pairLink)?.getAttribute("href") ?? null);
}

/** `https://…axiom-cdn.io/<mint>.webp` → `<mint>`. */
function mintFromImageSrc(src: string | null): string | null {
  if (src === null || src.startsWith("data:")) return null;
  const file = /\/([^/?#]+)\.(?:webp|png|jpe?g|gif|avif)(?:[?#]|$)/i.exec(src)?.[1] ?? null;
  return file !== null && isFullMint(file) ? file : null;
}

/**
 * Which column a card is in.
 *
 * The heading is found by text rather than by position, because a heading is
 * the one thing in a column that has to stay readable to a human and therefore
 * the one thing a redesign is least likely to rename.
 */
export function columnOf(card: Element): ObservationSource {
  const section = card.closest(SELECTORS.column);
  if (section === null) return "other";

  // Read only the section's first slice of text. The full textContent includes
  // every card in the column, and a coin named "Migrated" would otherwise move
  // its own column.
  const heading = firstTextTokens(section, 6).join(" ").toLowerCase();
  for (const [label, source] of COLUMN_SOURCES) {
    if (heading.includes(label)) return source;
  }
  return "other";
}

/** The first `limit` non-empty text tokens under `el`, in document order. */
function firstTextTokens(el: Element, limit: number): string[] {
  const out: string[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
  let node = walker.nextNode();
  while (node !== null && out.length < limit) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 0) out.push(text);
    node = walker.nextNode();
  }
  return out;
}

/** A text token and the element it came from. */
interface Token {
  text: string;
  parent: Element | null;
}

/**
 * Every text token in a card, in document order.
 *
 * Tokens are kept separate rather than read off `textContent`, and that is
 * load-bearing. Axiom renders its fee column as `0.0<sub>5</sub>4`, which
 * `textContent` flattens to `0.054` — a number that looks entirely reasonable
 * and is wrong by five orders of magnitude. Splitting per text node means such
 * a value can never accidentally reassemble into a plausible one.
 */
function tokensOf(card: Element): Token[] {
  const out: Token[] = [];
  const walker = card.ownerDocument.createTreeWalker(card, 4 /* SHOW_TEXT */);
  let node = walker.nextNode();
  while (node !== null) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 0) out.push({ text, parent: node.parentElement });
    node = walker.nextNode();
  }
  return out;
}

/** Axiom's compact duration, as rendered in the age slot: `1s`, `4m`, `1h`. */
const DURATION_SHAPE = /^\d+(?:\.\d+)?\s*[smhdw]$/i;

/** A money-shaped token: `$44.8K`, `$66`, `1.2M`. */
const MONEY_SHAPE = /^\$?\d[\d,]*(?:\.\d+)?\s*[KMBT]?$/i;

/**
 * Labels for the two figures we store, most specific first.
 *
 * Aliases rather than one string because the label is the *only* semantic
 * handle on these values — there is no attribute and no stable class — and it
 * is the kind of thing a redesign renames without meaning anything by it.
 */
const MARKET_CAP_LABELS = ["MC", "MCAP", "M.CAP", "MKT CAP", "MARKET CAP"];
const VOLUME_LABELS = ["V", "VOL", "VOLUME"];

/**
 * Whether a token is entangled with subscript notation.
 *
 * Checks both directions. A token can be a *sibling* of the `<sub>` (`0.0` and
 * `5` in `0.0<sub>4</sub>5`, whose parent contains it) or it can be the
 * subscript's own content (`4`, whose parent *is* it). Testing only one
 * direction lets half the digits through, which is worse than reading none of
 * them, because what gets through still looks like a number.
 */
function touchesSub(token: Token): boolean {
  const parent = token.parent;
  if (parent == null) return false;
  return parent.closest("sub") !== null || parent.querySelector("sub") !== null;
}

/**
 * Join consecutive tokens from `start` into the longest run that forms a value.
 *
 * Axiom does not render a figure as one text node. The committed capture splits
 * it one way and a live page splits it another:
 *
 *   capture   ["MC", "$3.17K"]           label, then the whole value
 *   live      ["MC", "$", "3.05K"]       label, currency, magnitude
 *
 * and nothing says a build will not split it further still. So rather than
 * encode a shape count, this accumulates and keeps the **longest** run that
 * parses — which is the part that matters. Taking the first match would read
 * `["$", "3.05", "K"]` as `$3.05` and drop the K: a thousandfold error, in the
 * exact field that decides whether a coin counts as having run, arriving as a
 * number that looks entirely reasonable.
 *
 * Accumulation stops at a subscript rather than reading through it.
 */
function joinValue(
  tokens: Token[],
  start: number,
  maxParts: number,
  shape: RegExp,
): string | null {
  let joined = "";
  let best: string | null = null;

  for (let n = 0; n < maxParts && start + n < tokens.length; n++) {
    const token = tokens[start + n] as Token;
    if (touchesSub(token)) break;
    joined += token.text.replace(/ /g, " ").trim();
    if (shape.test(joined)) best = joined;
  }

  return best;
}

/** Fold the cosmetic variation out of a label before comparing it. */
function labelKey(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[:\s]+$/, "")
    .trim()
    .toUpperCase();
}

/**
 * The value for a label such as `MC` or `V`.
 *
 * Handles both renderings, because the captured page uses the first and a live
 * page was observed using neither:
 *
 *   split   `<span>MC</span><span>$3.17K</span>`   → two tokens
 *   merged  `<span>MC $3.17K</span>`               → one token
 *
 * The original version required the split form and an exact string match, which
 * is why live extraction fell to 0% while mints stayed at 100%. Matching a
 * label is inherently softer than matching an attribute, so it is done softly:
 * case-insensitive, trailing colon and non-breaking space tolerated, aliases
 * accepted.
 *
 * Returns null when the value sits in a subtree containing a `<sub>` — that is
 * the subscript notation, and no single text node from it can be read as the
 * whole number.
 */
function valueForLabels(tokens: Token[], labels: readonly string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    const key = labelKey(token.text);

    for (const label of labels) {
      // Split form: the token is exactly the label and the value follows, in
      // however many pieces this build happens to render it.
      if (key === label) {
        const next = tokens[i + 1];
        if (next === undefined) continue;
        // A subscript value is refused outright rather than skipped: we found
        // the figure and established that it cannot be read correctly, which is
        // different from not having found it.
        if (touchesSub(next)) return null;
        const value = joinValue(tokens, i + 1, 4, MONEY_SHAPE);
        if (value !== null) return value;
        continue;
      }

      // Merged form: the label and its value share one text node. The money
      // check is what makes a one-letter label like `V` safe here — a coin
      // named VICTORY starts with V too, and only this rejects it.
      if (key.startsWith(label)) {
        const rest = token.text.replace(/ /g, " ").trim().slice(label.length).trim();
        if (rest.length > 0 && MONEY_SHAPE.test(rest)) {
          if (token.parent?.querySelector("sub") != null) return null;
          return rest;
        }
      }
    }
  }
  return null;
}

/**
 * Read one card into raw strings.
 *
 * Extraction is by shape and by position relative to the truncated mint, never
 * by class name. The layout the capture shows, consistently across all 30 cards
 * in all three columns:
 *
 *   [buy, buy, "V", <volume>, "MC", <cap>, "F", <fee…>, "TX", <count…>,
 *    "<trunc>...<mint>", "<TICKER>", "<name>", "<age>", …]
 *
 * The truncated mint is the anchor for the text fields because it is the one
 * token whose identity can be *verified* — it either agrees with the mint from
 * the attribute or it does not — which makes it a far better landmark than an
 * index into a list whose length varies with how many social badges a coin has.
 */
export function readCard(card: Element): RawRow {
  const mint = mintOf(card);
  const tokens = tokensOf(card);

  // The token image, identified by its filename matching the mint. A card can
  // hold more than one CDN image — a migrated pair also shows its quote token's
  // icon — so "the first img" is not good enough, and picking by mint is
  // self-validating.
  let imageUrl: string | null = null;
  let imageAlt: string | null = null;
  for (const img of card.querySelectorAll(SELECTORS.tokenImage)) {
    const src = img.getAttribute("src");
    if (src === null) continue;
    if (mint !== null && mintFromImageSrc(src) !== mint) continue;
    imageUrl = src;
    imageAlt = img.getAttribute("alt");
    break;
  }

  const truncatedIndex = tokens.findIndex((token) => /^.{2,}(?:\.{3}|…).{2,}$/.test(token.text));
  const truncated = truncatedIndex === -1 ? null : (tokens[truncatedIndex] as Token).text;

  let symbol: string | null = null;
  let name: string | null = null;
  let ageIndex = -1;

  if (truncatedIndex !== -1) {
    symbol = tokens[truncatedIndex + 1]?.text ?? null;
    const nameToken = tokens[truncatedIndex + 2]?.text ?? null;

    // A card with no name renders the age where the name would be. Reading it
    // as a name would store a coin called "4m" and lose the age entirely.
    if (nameToken !== null && DURATION_SHAPE.test(nameToken)) {
      ageIndex = truncatedIndex + 2;
    } else {
      name = nameToken;
      ageIndex = truncatedIndex + 3;
    }
  }

  // The age is the first duration-shaped token at or after its expected slot.
  // Searching forward rather than taking a fixed index matters: a migrated pair
  // renders a `0:31` countdown immediately after its age, and other cards carry
  // an extra badge before it.
  let age: string | null = null;
  if (ageIndex !== -1) {
    for (let i = ageIndex; i < tokens.length; i++) {
      const candidate = (tokens[i] as Token).text;
      if (DURATION_SHAPE.test(candidate)) {
        age = candidate;
        break;
      }
      // The same build that renders `MC $ 3.05K` across three nodes also
      // renders `0 %` across two, so a duration may well arrive as `14` `s`.
      // Joined only on an exact digits-then-unit pair rather than through the
      // greedy `joinValue`: a loose join here could fuse a holder count onto
      // the age and turn `5s` into `15s` without anything looking wrong.
      const next = tokens[i + 1]?.text ?? "";
      if (/^\d+(?:\.\d+)?$/.test(candidate) && /^[smhdw]$/i.test(next)) {
        age = candidate + next;
        break;
      }
    }
  }

  return {
    // `mintOf` has already validated this, but the contract downstream is a
    // href, so hand back something `parseMintFromHref` can read.
    mintHref: mint === null ? null : `/meme/${mint}`,
    mintText: truncated,
    // The image alt is the coin's name and is preferred over the positional
    // read: an attribute survives a layout change that reorders text nodes.
    name: imageAlt ?? name,
    symbol,
    imageUrl,
    // Axiom's Pulse markup does not expose a metadata URI anywhere. The
    // identical-URI shortcut therefore never fires from this surface; the
    // image URL is the usable proxy, and phase 4 uses it.
    metadataUri: null,
    marketCap: valueForLabels(tokens, MARKET_CAP_LABELS),
    volume: valueForLabels(tokens, VOLUME_LABELS),
    age,
  };
}

/**
 * What a card actually contains, for when extraction is failing on a live page
 * and the committed fixture cannot explain why.
 *
 * The scraper degrading is not hypothetical — it happened on the first live
 * run, with mints at 100% and both figures at 0%, and the capture in
 * `fixtures/` disagreed with the page in front of the user. Rather than trade
 * guesses, the extension prints this itself when it notices it is degraded.
 *
 * Deliberately just the token list and the resolved fields: enough to see which
 * assumption broke, and nothing that identifies the person running it.
 */
export function describeCard(card: Element): {
  mint: string | null;
  tokens: string[];
  fields: RawRow;
} {
  return {
    mint: mintOf(card),
    tokens: tokensOf(card).map((token) => token.text),
    fields: readCard(card),
  };
}
