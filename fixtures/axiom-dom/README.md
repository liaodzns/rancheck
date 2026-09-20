# axiom-dom

Captured Axiom DOM, for scraper tests.

## Why these are kept

Axiom is a React app with virtualised, frequently-redesigned lists, and the
scraper is the part of this project most likely to break. A committed capture is
what makes `test/scrape.test.ts` able to assert an exact per-field extraction
rate — which is the earliest available warning that something has moved.

## Capturing a new one

In DevTools on the page you want, with any overlay panels closed so the columns
are fully rendered:

```js
const html = document.documentElement.outerHTML;
const a = document.createElement('a');
a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
a.download = `axiom-pulse-${Date.now()}.html`;
a.click();
```

Then scrub it before it goes anywhere near a commit:

```
node scripts/scrub-dom-fixture.mjs <raw>.html fixtures/axiom-dom/pulse-<date>.html
```

**A raw capture is a logged-in session dump.** It carries the wallet address and
balance, the portfolio value, preset configuration and a megabyte of Next.js
hydration state. The scrubber keeps only the feed sections and refuses to write
output that still matches a JWT, a bearer token, an API key or an email address.
Raw captures are gitignored so one cannot be committed by reflex; delete yours
once it is scrubbed.

## pulse-2026-09-19.html

The Pulse screen: three columns and the ticker strip, 30 cards total — New Pairs
12, Final Stretch 6, Migrated 12.

Worth knowing about this capture, because tests depend on all of it:

- **The Pulse cards are not anchors.** The 15 `a[href*="/meme/"]` in the file are
  all in the ticker strip. The cards are divs carrying
  `data-pulse-token-address`. This is the fact that corrected the spec's first
  scraper rule; see the header of `src/content/selectors.ts`.
- **The Boring Company** (`BQkG…GUrK`, Migrated) renders a second token image
  for WBTC alongside its own, and a `0:31` countdown immediately after its age.
  It is the card that proves image selection must key on the mint and that the
  age cannot be read from a fixed offset.
- **The Rogue AI** (`1TGF…q2BH`, New Pairs) renders its fee as
  `0.0<sub>5</sub>4`, which `textContent` flattens to `0.054`. It is why the
  scraper tokenises per text node instead.
- **POORCAT** has an identical name and ticker.
- The same coin can appear in two columns at once, which is why a pass dedupes
  by mint.

Still missing: a pair detail page (`/meme/<mint>`). The spec wants that surface
scraped too — same mint key, richer fields.
