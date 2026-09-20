/**
 * Field parsers.
 *
 * Everything here turns one string Axiom rendered into one value we can store,
 * and none of it touches the DOM. That separation is the point: `selectors.ts`
 * holds the assumptions that a redesign breaks, and this file holds the ones it
 * cannot. `$44.8K` means 44800 whatever element it was found in.
 *
 * The governing rule, inherited from the spec's treatment of a failed image
 * hash: **a value we cannot parse confidently becomes null, never a guess.** A
 * null propagates honestly — the matcher tolerates missing fields and the badge
 * can say it does not know. A wrong number does not announce itself, and a
 * market cap off by a factor of ten silently decides whether a coin counts as
 * having run.
 */

/** Seconds per unit, for the compact durations Axiom renders as `9m`, `1h`. */
const DURATION_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/** Multipliers for the compact magnitudes Axiom renders as `$44.8K`, `$1.11M`. */
const MAGNITUDE_UNITS: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
  t: 1e12,
};

/**
 * Subscript digits, as used in crypto price notation like `$0.0₂4`.
 *
 * Detected only so it can be rejected. The notation is genuinely ambiguous in
 * the wild — the subscript variously means "zeros after the decimal point" or
 * "additional zeros beyond the one shown" — and the two readings differ by a
 * factor of ten. Axiom uses it for prices and fees, which this project does not
 * store; market cap and volume are always rendered plainly. So the honest move
 * is to return null rather than pick a convention and be silently wrong about
 * it in a field nobody needed.
 */
const SUBSCRIPT_DIGITS = /[₀-₉]/;

/**
 * Parse a compact number: `$44.8K`, `1,571`, `$1.11M`, `0.03`, `500+`.
 *
 * Returns null for anything that is not confidently a number — an empty string,
 * a dash placeholder, a price in subscript notation, or text that merely
 * contains digits.
 *
 * `500+` parses as 500 and is a floor, not a count. Axiom uses it on badges
 * where the true value is above a display cap. Nothing currently stores one; if
 * something ever does, it must not be compared for equality.
 */
export function parseCompactNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  // Axiom renders an absent value as a dash or an em-dash rather than omitting
  // the element, so this is a real case and not defensive.
  if (/^[-–—]+$/.test(trimmed)) return null;

  if (SUBSCRIPT_DIGITS.test(trimmed)) return null;

  const match = /^[$\s]*([\d,]+(?:\.\d+)?)\s*([kmbt])?\s*\+?$/i.exec(trimmed);
  if (match === null) return null;

  const digits = (match[1] as string).replace(/,/g, "");
  const magnitude = match[2];

  const base = Number(digits);
  if (!Number.isFinite(base)) return null;

  if (magnitude === undefined) return base;
  const multiplier = MAGNITUDE_UNITS[magnitude.toLowerCase()];
  if (multiplier === undefined) return null;
  return base * multiplier;
}

/**
 * Parse a compact duration into seconds: `29s`, `9m`, `1h`, `24m`, `2d`.
 *
 * Multi-unit forms (`1h 30m`) sum, because a feed that has been open a while
 * will render them and dropping the minutes would quietly age a coin wrong.
 *
 * This is an age as Axiom computed it at render time, not a timestamp. It goes
 * stale the moment it is read, which is why `PairObservation` also carries
 * `seenAt` — the pair of them is what lets a later pass work out roughly when a
 * coin launched, and neither alone is enough.
 */
export function parseAgeSeconds(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  // Reject anything that is not exclusively duration parts, so a stray `9` from
  // some other column cannot be read as nine of an unknown unit.
  if (!/^(?:\d+(?:\.\d+)?\s*[smhdw]\s*)+$/.test(trimmed)) return null;

  let total = 0;
  for (const part of trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([smhdw])/g)) {
    const amount = Number(part[1]);
    const unit = DURATION_UNITS[part[2] as string];
    if (!Number.isFinite(amount) || unit === undefined) return null;
    total += amount * unit;
  }
  return total;
}

/** Base58, the Solana alphabet: no 0, O, I or l. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Pull the mint out of an Axiom pair link.
 *
 * Every row on Axiom links to `/meme/<mint>`, and that mint is this project's
 * primary key: it is canonical, it survives every DOM redesign, and it cannot
 * change without breaking Axiom itself. Accepts an absolute URL, a
 * protocol-relative one or a bare path, and tolerates a query string or hash,
 * because which of those the markup uses is exactly the kind of detail a
 * redesign changes without meaning anything by it.
 *
 * The base58 check is what makes this safe to key on. Without it a redesign
 * that changed the route to `/meme/trending` would start writing corpus entries
 * under the mint `trending`.
 */
export function parseMintFromHref(href: string | null | undefined): string | null {
  if (href === null || href === undefined) return null;

  const match = /\/meme\/([^/?#]+)/.exec(href.trim());
  if (match === null) return null;

  let candidate: string;
  try {
    candidate = decodeURIComponent(match[1] as string);
  } catch {
    // A malformed percent-escape. Not a mint.
    return null;
  }

  return BASE58.test(candidate) ? candidate : null;
}

/**
 * Whether a string is a complete mint rather than Axiom's display form.
 *
 * Axiom prints mints truncated in the card footer — `BQkG...GUrK`, `Grmg...pump`
 * — and those are lossy. Two different mints sharing a prefix and suffix would
 * collide, and a corpus keyed on them would silently merge two coins into one
 * entry, which is the single worst thing this project could do: the whole
 * product is a count of distinct prior deployments.
 *
 * So a truncated mint is never a key. It is useful only as a cross-check that
 * the href we parsed belongs to the row we think it does.
 */
export function isFullMint(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return BASE58.test(value.trim());
}

/**
 * Whether a truncated display mint is consistent with a full one.
 *
 * Virtualised lists recycle nodes, so the anchor and the footer text can
 * momentarily belong to different coins mid-update. Comparing them is a cheap
 * way to notice and skip the row rather than store a mismatch.
 *
 * Returns true when the display form is absent or unrecognisable: the check can
 * only ever veto, and an absent footer is not evidence of a problem.
 */
export function truncatedMintMatches(
  truncated: string | null | undefined,
  fullMint: string,
): boolean {
  if (truncated === null || truncated === undefined) return true;

  const parts = truncated.trim().split(/\.{2,}|…/);
  if (parts.length !== 2) return true;

  const [head, tail] = parts as [string, string];
  if (head.length === 0 || tail.length === 0) return true;

  return fullMint.startsWith(head) && fullMint.endsWith(tail);
}

/**
 * Tidy a scraped name or ticker, or reject it.
 *
 * Collapses whitespace — Axiom's markup leaves plenty between inline elements —
 * and returns null for an empty result so callers store null rather than "".
 *
 * Deliberately does almost nothing else. Case, emoji, punctuation and lookalike
 * characters are all folded by `normalize()` at match time, and doing any of it
 * here would throw away what the coin actually called itself, which is what the
 * popover has to show the user.
 */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? null : collapsed;
}

/**
 * Resolve an image URL against the page, and reject what cannot be hashed.
 *
 * Phase 4 fetches these in the service worker to compute a perceptual hash, and
 * a `data:` or `blob:` URL is useless there: a blob URL is scoped to the page's
 * own lifetime and will not resolve from a worker, and a data URL would mean
 * storing image bytes, which the storage budget explicitly rules out.
 */
export function cleanImageUrl(
  value: string | null | undefined,
  base?: string | undefined,
): string | null {
  const text = cleanText(value);
  if (text === null) return null;
  if (/^(?:data|blob):/i.test(text)) return null;

  try {
    return new URL(text, base ?? "https://axiom.trade/").toString();
  } catch {
    return null;
  }
}
