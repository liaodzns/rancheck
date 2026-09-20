/**
 * Field parsers.
 *
 * Values here are taken from the Pulse screenshot in `fixtures/axiom-dom/`
 * rather than invented, so these are the strings Axiom actually renders.
 */
import { describe, expect, it } from "vitest";
import {
  cleanImageUrl,
  cleanText,
  isFullMint,
  parseAgeSeconds,
  parseCompactNumber,
  parseMintFromHref,
  truncatedMintMatches,
} from "../src/content/parse.js";

describe("parseCompactNumber", () => {
  it("parses the market caps and volumes on screen", () => {
    expect(parseCompactNumber("$44.8K")).toBe(44800);
    expect(parseCompactNumber("$81.9K")).toBe(81900);
    expect(parseCompactNumber("$1.11M")).toBe(1_110_000);
    expect(parseCompactNumber("$876K")).toBe(876_000);
    expect(parseCompactNumber("$819")).toBe(819);
    expect(parseCompactNumber("$50")).toBe(50);
  });

  it("parses bare numbers and thousands separators", () => {
    expect(parseCompactNumber("1571")).toBe(1571);
    expect(parseCompactNumber("17,588")).toBe(17_588);
    expect(parseCompactNumber("4.246")).toBe(4.246);
    expect(parseCompactNumber("0.03")).toBe(0.03);
  });

  it("is case-insensitive about the magnitude suffix", () => {
    expect(parseCompactNumber("44.8k")).toBe(44800);
    expect(parseCompactNumber("1.11m")).toBe(1_110_000);
    expect(parseCompactNumber("2b")).toBe(2e9);
  });

  it("treats a display-capped count as its floor", () => {
    // Axiom's `500+` badge. A lower bound, not a count — never compare it for
    // equality with anything.
    expect(parseCompactNumber("500+")).toBe(500);
  });

  it("returns null for an absent value rather than zero", () => {
    // Zero is a real market cap. Conflating "no volume" with "didn't parse"
    // would make a coin look measured when it was not.
    expect(parseCompactNumber(null)).toBeNull();
    expect(parseCompactNumber(undefined)).toBeNull();
    expect(parseCompactNumber("")).toBeNull();
    expect(parseCompactNumber("   ")).toBeNull();
    expect(parseCompactNumber("-")).toBeNull();
    expect(parseCompactNumber("—")).toBeNull();
  });

  it("refuses subscript price notation rather than guessing a convention", () => {
    // `0.0₂4` is ambiguous in the wild by a factor of ten, and we do not store
    // prices. Null is the honest answer; a number would be a silent guess.
    expect(parseCompactNumber("0.0₂4")).toBeNull();
    expect(parseCompactNumber("$0.0₅1234")).toBeNull();
  });

  it("refuses text that merely contains digits", () => {
    // The shape-based extractor will hand this function whatever token looked
    // numeric, so rejecting confidently matters more than parsing generously.
    expect(parseCompactNumber("TX 1571")).toBeNull();
    expect(parseCompactNumber("9m ago")).toBeNull();
    expect(parseCompactNumber("P3")).toBeNull();
    expect(parseCompactNumber("0.03 SOL")).toBeNull();
    expect(parseCompactNumber("$12.9K MC")).toBeNull();
  });

  it("rejects an unknown magnitude suffix", () => {
    expect(parseCompactNumber("44.8Q")).toBeNull();
  });
});

describe("parseAgeSeconds", () => {
  it("parses the ages on screen", () => {
    expect(parseAgeSeconds("5s")).toBe(5);
    expect(parseAgeSeconds("29s")).toBe(29);
    expect(parseAgeSeconds("1m")).toBe(60);
    expect(parseAgeSeconds("9m")).toBe(540);
    expect(parseAgeSeconds("24m")).toBe(1440);
    expect(parseAgeSeconds("1h")).toBe(3600);
  });

  it("sums multi-unit durations", () => {
    // A feed left open renders these, and dropping the minutes would quietly
    // age a coin wrong.
    expect(parseAgeSeconds("1h 30m")).toBe(5400);
    expect(parseAgeSeconds("2d 4h")).toBe(187_200);
  });

  it("is case-insensitive and tolerates spacing", () => {
    expect(parseAgeSeconds("9M")).toBe(540);
    expect(parseAgeSeconds("  1h  ")).toBe(3600);
  });

  it("refuses a bare number with no unit", () => {
    // Nine of what? A stray token from another column must not become an age.
    expect(parseAgeSeconds("9")).toBeNull();
  });

  it("refuses unknown units and trailing text", () => {
    expect(parseAgeSeconds("9y")).toBeNull();
    expect(parseAgeSeconds("9m ago")).toBeNull();
    expect(parseAgeSeconds("TX 3")).toBeNull();
    expect(parseAgeSeconds("")).toBeNull();
    expect(parseAgeSeconds(null)).toBeNull();
  });
});

describe("parseMintFromHref", () => {
  const MINT = "AtbSvZug8WZM4AuDb9MYryXbr3okXrk8BZGGCwvqpump";

  it("accepts the URL shapes a redesign might switch between", () => {
    expect(parseMintFromHref(`/meme/${MINT}`)).toBe(MINT);
    expect(parseMintFromHref(`https://axiom.trade/meme/${MINT}`)).toBe(MINT);
    expect(parseMintFromHref(`//axiom.trade/meme/${MINT}`)).toBe(MINT);
    expect(parseMintFromHref(`/meme/${MINT}?ref=pulse`)).toBe(MINT);
    expect(parseMintFromHref(`/meme/${MINT}#chart`)).toBe(MINT);
    expect(parseMintFromHref(`/meme/${MINT}/`)).toBe(MINT);
  });

  it("decodes percent-encoding, since axiomLink() encodes", () => {
    expect(parseMintFromHref(`/meme/${encodeURIComponent(MINT)}`)).toBe(MINT);
  });

  it("rejects a route segment that is not a mint", () => {
    // Without the base58 check, a redesign routing to /meme/trending would
    // start writing corpus entries keyed on the word "trending".
    expect(parseMintFromHref("/meme/trending")).toBeNull();
    expect(parseMintFromHref("/meme/")).toBeNull();
    expect(parseMintFromHref("/portfolio")).toBeNull();
    expect(parseMintFromHref(null)).toBeNull();
  });

  it("rejects base58-illegal characters", () => {
    // 0, O, I and l are not in the alphabet; a string containing them is not a
    // Solana address however long it is.
    expect(parseMintFromHref("/meme/0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl")).toBeNull();
  });

  it("rejects a malformed percent-escape instead of throwing", () => {
    expect(parseMintFromHref("/meme/%E0%A4%A")).toBeNull();
  });
});

describe("isFullMint", () => {
  it("accepts a real mint and rejects Axiom's display form", () => {
    expect(isFullMint("AtbSvZug8WZM4AuDb9MYryXbr3okXrk8BZGGCwvqpump")).toBe(true);
    expect(isFullMint("BQkG...GUrK")).toBe(false);
    expect(isFullMint("")).toBe(false);
    expect(isFullMint(null)).toBe(false);
  });
});

describe("truncatedMintMatches", () => {
  const MINT = "BQkGabcdefghijkmnopqrstuvwxyz23456789ABGUrK";

  it("accepts a display form consistent with the full mint", () => {
    expect(truncatedMintMatches("BQkG...GUrK", MINT)).toBe(true);
    expect(truncatedMintMatches("BQkG…GUrK", MINT)).toBe(true);
  });

  it("rejects one that is not", () => {
    // What a recycled node looks like mid-update: the anchor has moved on to
    // the next coin while the footer still shows the last one.
    expect(truncatedMintMatches("Grmg...pump", MINT)).toBe(false);
  });

  it("abstains when there is nothing to check", () => {
    // The cross-check can only veto. An absent or unparseable footer is not
    // evidence of a mismatch, and treating it as one would drop good rows.
    expect(truncatedMintMatches(null, MINT)).toBe(true);
    expect(truncatedMintMatches("", MINT)).toBe(true);
    expect(truncatedMintMatches("no-ellipsis-here", MINT)).toBe(true);
  });
});

describe("cleanText", () => {
  it("collapses the whitespace inline markup leaves behind", () => {
    expect(cleanText("  The Boring   Company\n")).toBe("The Boring Company");
  });

  it("returns null rather than an empty string", () => {
    expect(cleanText("   ")).toBeNull();
    expect(cleanText(null)).toBeNull();
  });

  it("preserves what the coin called itself", () => {
    // Case, emoji and punctuation are folded by normalize() at match time. Doing
    // it here would throw away what the popover has to show the user.
    expect(cleanText("THURSDAY ARENA 🔥")).toBe("THURSDAY ARENA 🔥");
    expect(cleanText("IceOn$hark")).toBe("IceOn$hark");
  });
});

describe("cleanImageUrl", () => {
  it("resolves a relative source against the page", () => {
    expect(cleanImageUrl("/img/a.png", "https://axiom.trade/pulse")).toBe(
      "https://axiom.trade/img/a.png",
    );
  });

  it("passes an absolute URL through", () => {
    expect(cleanImageUrl("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
  });

  it("rejects sources the worker could never fetch", () => {
    // Phase 4 hashes these from the service worker. A blob URL is scoped to the
    // page's lifetime and will not resolve there; a data URL would mean storing
    // image bytes, which the storage budget rules out.
    expect(cleanImageUrl("blob:https://axiom.trade/abc")).toBeNull();
    expect(cleanImageUrl("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
    expect(cleanImageUrl("")).toBeNull();
    expect(cleanImageUrl(null)).toBeNull();
  });
});
