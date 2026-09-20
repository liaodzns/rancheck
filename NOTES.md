# NOTES

Implementation commentary, phase by phase. Decisions and their reasons, and the
measurements behind any number that ended up in the code.

---

## Phase 1 — matching, offline, no browser

Goal from the spec: port `narrative.ts`, copy the fixture, and prove the known
facts in tests. When they pass, matching is done and is never touched again.

**Status: done.** 46 tests, `npm run check` clean (typecheck + port diff + tests).

### The port is verbatim, and that is enforced

`src/worker/match.ts` is argus's `packages/engine/src/narrative.ts` byte for
byte, with exactly one edit: the import path, from `@argus/shared` to
`../shared/types.js`.

The spec says not to rewrite it and not to "improve" the normalisation, because
its comments carry findings measured against a recording that cannot be
re-created on demand. That is an easy instruction to follow today and an easy
one to quietly break in six months, so it is checked rather than trusted:
`scripts/verify-port.mjs` strips our header banner, diffs the rest against the
argus checkout line by line, and allows exactly one changed line. It runs as
part of `npm run check` and skips with a notice when `argus/` is absent, since
argus is gitignored and is not a dependency.

The consequence worth stating plainly: **no fix belongs in `match.ts`.** Corpus
iteration went into `match-corpus.ts`; candidate generation goes into
`index-store.ts` in phase 3. If something about matching seems wrong, the answer
is almost certainly that the wrapper is asking the wrong question.

### Adapting one-against-one to one-against-many

argus holds one parent — the coin you just bought — and asks whether an incoming
launch is a clone of it. rancheck has no parent: it has a row on screen and a
corpus, and asks how many corpus entries are the same thing.

Different shape, same matching. `matchCorpus` calls `matchNarrative` once per
candidate with the corpus entry in the parent's position, and adds only
iteration, self-exclusion and ordering. Signature untouched, as instructed.

Two details that are not obvious:

- **Self-exclusion is by mint, not by object identity.** The subject is a freshly
  scraped observation; the candidate is a stored row. Different objects, same
  coin. Compare them and you get 1.0, which inflates every count by exactly one
  and makes every coin look like it has run before.
- **Ties break by mint.** Otherwise result order is candidate order, which will
  be IndexedDB cursor order, which is not something the popover should quietly
  depend on.

`matchCorpus` takes whatever candidate list it is handed and does not care how
it was narrowed. That is deliberate: it stays correct when passed the entire
corpus and is only slow, so phase 3's blocking index is a pure optimisation that
cannot change an answer.

### Why clustering is single-link

`clusterByNarrative` exists to characterise the fixture, and it joins A to C when
both match B even though A and C do not match each other.

That is not a convenience, it is the only linkage that describes this data. The
recorded wave contains rows named `Cupcake` with ticker `CUPCAKE`, and rows named
`THURSDAY ARENA` with ticker `THURSDAY`. Those two share nothing and score null
against each other. They are one wave only because rows named `thursdayarena`
with ticker `CUPCAKE` sit between them and match both ends. Require every member
to match every other and the wave shatters into the pieces its deployer was
mutating between — which is precisely the opposite of what a count is for.

It is O(n²) and must stay off the hot path. It is a fixture-characterisation and
offline-analysis tool. The badge never calls it; the badge counts matches against
one subject over a narrowed candidate list.

### What was measured, and where the spec's numbers landed

Everything below is measured through the ported code against
`fixtures/launches-2026-09-17.json` at `min_similarity: 0.90`, `min_length: 3`.
The spec quotes figures from an earlier read of the same recording at a 0.85
threshold; where they differ, the measured value is what the tests assert, with
the spec's figure noted next to it.

| Fact | Spec | Measured | Note |
|---|---|---|---|
| Thursday Arena wave size | ~25 | **27** | asserted exactly; a one-member drift is worth noticing |
| Matches per wave member | ~26 | **24 or 26** (two bridges at 11) | |
| Mean matches per launch | 6.14 @ 0.85 | **5.71** @ 0.90 | tighter threshold, fewer matches |
| Mean from exact-match only | 6.03 | **5.64** | fuzzy layer adds ~1.2% |
| Launches matching nothing | "half" | **66 of 123** (54%) | |
| Identical-URI groups | "several" | **7**, sizes 2,2,2,2,3,3,5 | all score 1.0 via metadata |
| Unmatchable-name launches | 8 | **8** | see below |

**The "8 blank names" needed reconciling.** Seven launches have an empty name
*and* an empty symbol. The eighth is named `T` with ticker `T`, which normalises
to a single character. The spec calls all eight blank; what they actually share
is that both fields fall under `minLength`. That distinction matters, because it
says what the guard is really for: **comparability, not emptiness.** A one-letter
name is not blank and still matches far too much. The test asserts 8 unmatchable
and 7 strictly empty, so the distinction cannot be lost later.

**The bimodality is a literally empty gap.** The full distribution of per-launch
match counts:

```
0: 66   1: 10   2: 15   4: 5   |   11: 2   24: 15   26: 10
         ^ 96 launches ≤ 4         ^ 27 launches ≥ 11
              nothing at all between 5 and 10
```

The spec says the threshold "sits in a wide empty gap" and almost any value
works. It is emptier than that phrasing suggests — not sparse, empty. The test
asserts `counts.filter(c => c >= 5 && c <= 10)` is `[]`, which is a stronger and
more honest statement than any inequality about the modes. It is also why a badge
can be trusted at all: there is no ambiguous middle for it to misreport.

One assertion in this area was wrong on the first pass. I guessed that few
launches would fall in a "middling" 1–4 band and asserted it was smaller than the
high mode. It is not — 30 launches match between 1 and 4 others, mostly the
identical-URI pairs and the small groups, against 27 in the high mode. The guess
was mine, not the spec's, and replacing it with the measured empty gap is a
better test than the one I meant to write.

### Departures from argus worth recording

- **Zod is gone.** argus validates at process boundaries because its events cross
  a Redis bus written by another process. Nothing here crosses a boundary we do
  not own: the scraper hands observations to a worker inside the same extension.
  The one place untrusted JSON genuinely arrives is the phase 5 importer, which
  validates at its own edge rather than making every consumer carry a runtime
  schema. ~12KB of extension bundle for a guarantee we do not need is the wrong
  trade.
- **`MintEvent` and `TokenMeta` carry only the fields matching reads.** The argus
  shapes have ~20 more serving scoring, monitoring and safety, all explicit
  non-goals. `MintEvent` is kept rather than renamed because it is genuinely this
  project's shape too: the fixture is a list of them, and phase 5's PumpPortal
  recorder produces them.
- **`axiomLink()` lives in `shared/config.ts`, not its own file.** It is one
  function and it belongs next to the reasoning about why it is the whole of the
  Axiom integration.
- **`narrativeWithImage` (0.72) is carried but unused.** It is argus's
  `signals.vamp_of_runner.min_similarity` — the looser text bar for when an image
  phash is also in play. Nothing has a phash until phase 4; it is here so the
  pair of numbers stays in one file rather than being rediscovered later.

### Toolchain

Node 20.19.5 locally, so `engines` says `>=20`. Vitest rather than `node:test`,
chosen with phases 2–4 in mind: the DOM-fixture tests need a jsdom-style
environment and the corpus tests need `fake-indexeddb`, and both are a config
line in vitest against a migration otherwise. No bundler yet — nothing needs
bundling until there is a manifest to load.

`argus/` is gitignored. It is a local reference copy, not ours to commit, and it
carries a `.env`.

### Open, for later phases

- **The corpus subject type takes `uri: string`, not `string | null`.** A scraped
  `PairObservation` carries `metadataUri: string | null`, so the caller converts
  with `?? ""`. The port declines to short-circuit on an empty URI, which is the
  metadata-domain twin of the blank-name guard and is tested. Worth keeping the
  conversion at that one call site rather than loosening the type.
- **Phase 4 will want `matchedOn: "image"`.** The value already exists in the
  `NarrativeMatch` union, carried over from argus. The phash path will need to
  merge its own result with the text result rather than route through
  `matchNarrative`, which knows nothing about images — another reason the wrapper
  is where adaptation belongs.

---

## Phase 2 — the scraper, read-only

Goal from the spec: a content script that logs `PairObservation[]` and ships no
UI, DOM snapshots committed as fixtures, and scraper tests written against them.
Judged on per-field extraction rate across a few hundred rows.

**Status: done.** 115 tests, `npm run check` clean, `npm run build` produces a
loadable unpacked extension.

### The spec's first scraper rule is wrong, and it fails silently

The spec says to anchor on the mint: find `a[href*="/meme/"]`, parse the mint
out of the href, walk up to the row. Measured against the capture, that does not
work — and it fails in the most expensive way available, which is that it
appears to work.

The captured Pulse page holds 15 `/meme/` anchors. **Every one is in the price
ticker strip along the top.** The three columns hold 30 cards between them and
contain no anchors at all; they are divs with click handlers, which is what a
React app usually does. A scraper built on the spec's rule returns 15
plausible-looking rows scraped from a ticker, and the corpus quietly fills with
coins that were never on the feed.

What the cards carry instead is `data-pulse-token-address`, holding the full
mint. The spec's *reasoning* is what makes that trustworthy and it transfers
intact: it is application instrumentation rather than styling, it is the
identity Axiom's own code keys on, and it cannot drift without breaking the
page. The hashed Tailwind classes around it change every deploy; this does not.

The mint turns out to be attested four independent ways on every card — the
attribute, the CDN image filename, a `pump.fun/coin/<mint>` link and an
`x.com/search?q=<mint>` link — so `mintOf()` falls through them in order rather
than trusting any one. There is a test that strips the attribute and confirms
the image filename alone still resolves the right mint.

`test/scrape.test.ts` has a test asserting the ticker strip yields zero cards.
That is the test that would have caught this, so it is worth keeping pointed at.

### Three traps in the real markup

**The subscript fee.** Axiom renders fees as `0.0<sub>5</sub>4`. Flattened by
`textContent` that is `"0.054"` — an entirely believable number, wrong by five
orders of magnitude. The scraper therefore tokenises per text node rather than
reading `textContent`, so such a value can never reassemble into a plausible
one, and `valueAfterLabel` additionally refuses any value whose subtree contains
a `<sub>`. We do not store fees, but the same notation could appear in a price
column tomorrow, and the failure would be invisible.

**The second image.** The Boring Company, in Migrated, renders a WBTC icon
alongside its own token image. "The first `<img>`" and "the first CDN `<img>`"
both pick wrong. Images are selected by filename matching the mint, which is
self-validating and is the same fact that makes the image a mint fallback. In
phase 4 this would have become the wrong perceptual hash on a coin — a false
"has run before" that no amount of threshold tuning would fix.

**The countdown.** The same card renders `4m` and then `0:31`. Age is found by
scanning forward from its expected slot for a duration-shaped token rather than
taking a fixed index. A card with no name also renders its age where the name
would go, so there is a guard for that too: storing a coin named `4m` and losing
the age is worse than storing a null name.

### Extraction rate

100% on every tracked field across all 30 cards: name, symbol, imageUrl,
marketCapUsd, volumeUsd, ageSeconds. Asserted exactly rather than as a floor —
this is the metric the spec says to judge the phase on, and drift in it is the
earliest warning available.

`metadataUri` is 0% and that is not a failure: Pulse does not expose one
anywhere. The consequence is real though — **the identical-URI shortcut from
argus, the cheapest true positive in the matcher, never fires from this
surface.** The image URL is the usable proxy the spec suggests, and phase 4 is
where it starts paying. `diagnose()` deliberately excludes `metadataUri` from
the redesign check, because a field that has always been 0% is not a regression
and warning about it every pass would train the warning to be ignored.

### The same coin in two columns

A pair in Final Stretch also sits in New Pairs, with identical numbers, and both
are scraped in the same pass. `dedupeByMint` collapses them, keeping the most
complete row rather than the first. Without it every such coin is written twice
per tick and its sighting count — which phase 3 uses to judge how well observed
a coin is — inflates on nothing but layout.

This is also why `source` gained `final-stretch` and `migrated`. `migrated` is
not cosmetic: phase 4's run rule is peak market cap over a floor **or** having
been seen in a migrated context, and that second clause is the only run signal
that does not depend on having had the tab open at the right moment.

### Structure

`selectors.ts` holds every DOM assumption and nothing else may query the page.
`parse.ts` holds the conversions, which are DOM-independent — `$44.8K` is 44800
whatever markup wraps it — and was written and fully tested before the capture
arrived, then needed no changes when it did. `observation.ts` assembles and
tallies. `scrape.ts` is orchestration only.

Two deviations from the spec's layout, both to keep the fragile part small:
`parse.ts` and `observation.ts` are not in its file list. The spec says to
isolate `scrape.ts` as the fragile part; splitting the *non*-fragile logic out
is the same instruction applied honestly.

### Things that cost time, or nearly did

- `instanceof Element` in `scrape.ts` threw under test. jsdom's `Element` is not
  the global one, and a content script and a test hold different realms. Now
  duck-typed via `ownerDocument`, which is also the right answer for a fragment.
- The fixture is 507KB, 318KB of which is Tailwind class attributes. Kept
  deliberately: stripping them would let a selector accidentally depend on a
  class name and still pass tests.
- The scrubber refuses to write output still matching a JWT, bearer token, API
  key, email or Next.js hydration payload. Raw captures are gitignored. A raw
  capture carries the wallet address, balance and portfolio value, and this repo
  is public.

### Open

- **No detail-page fixture yet.** The spec wants `/meme/<mint>` scraped too —
  same mint key, richer fields, and it is where the answer is most wanted.
  Needs a capture.
- **The visibility gate is untested in anger.** `IntersectionObserver` gating is
  wired and unit-tested through an injected predicate, but its real cost shows
  up only against a live feed at 31 launches/minute.
- **`ExtractionTally` is per-pass.** Judging "a few hundred rows" properly wants
  it accumulated across passes and persisted. Phase 3 has storage; that is where
  it belongs.
