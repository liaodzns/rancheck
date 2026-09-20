# COMMITS

Change log, newest last. Conventional commits.

---

## Phase 0 — the governing documents

### `docs: add the build brief and working instructions`

`RERUN-SPEC.md` is the build brief: what is a port from argus, what is new work,
and which numbers were measured rather than guessed. `CLAUDE.md` is the working
instruction that this file and `NOTES.md` exist to satisfy.

Both were written before any code and are committed first so every commit after
them can be read against the brief they answer to.

Files:

- `RERUN-SPEC.md`
- `CLAUDE.md`

---

## Phase 1 — matching, offline, no browser



### `chore: scaffold typescript project and ignore the argus reference copy`

Project skeleton: `package.json` (ESM, Node >=20, vitest), `tsconfig.json`
(strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` carried
over from `argus/tsconfig.base.json`), `vitest.config.ts`.

`.gitignore` gains `node_modules/` and `dist/`, and keeps `argus/` — the local
reference copy is not ours to commit and carries a `.env`.

Files:

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vitest.config.ts`
- `.gitignore`



### `feat(shared): add the type contract and the thresholds file`

`src/shared/types.ts` carries the argus shapes the matcher needs — `MintEvent`,
`TokenMeta`, `NarrativeMatch` — plus `PairObservation`, the scraper's output
contract from the spec. No zod: nothing here crosses a process boundary we do not
own, and the phase 5 importer validates at its own edge.

`src/shared/config.ts` mirrors the practice of `argus/config/thresholds.yml` —
every tunable number in one file with its reason beside it, and an honest note
about which are guesses. Carries `narrative` (0.90 / 3, measured) and
`narrativeWithImage` (0.72, argus's `vamp_of_runner` bar, unused until phase 4).
`axiomLink()` lives here too, with the reasoning about why it is the entire Axiom
integration.

Files:

- `src/shared/types.ts`
- `src/shared/config.ts`



### `feat(worker): port argus narrative matching verbatim`

`src/worker/match.ts` is `argus/packages/engine/src/narrative.ts` byte for byte,
with one edit: the import path. `normalize`, `jaro`, `jaroWinkler` and
`matchNarrative`, comments included — those comments carry findings measured
against a recording that cannot be re-created on demand.

`scripts/verify-port.mjs` enforces it: strips our banner, diffs the rest against
the argus checkout, allows exactly one changed line, and skips cleanly when
`argus/` is absent. Wired up as `npm run verify:port` and into `npm run check`.

Files:

- `src/worker/match.ts`
- `scripts/verify-port.mjs`
- `package.json` (adds `verify:port` and `check`)



### `feat(worker): match one launch against a corpus`

`src/worker/match-corpus.ts`. The spec's required adaptation — argus matches one
parent against one launch, rancheck matches one launch against many stored coins
— done as a wrapper, with `matchNarrative`'s signature untouched.

`matchCorpus` adds iteration, self-exclusion by mint (comparing a coin to itself
scores 1.0 and inflates every count by one) and stable ordering by similarity
then mint. It scores whatever candidate list it is handed and does not care how
that list was narrowed, so phase 3's blocking index cannot change an answer.

`clusterByNarrative` is single-link union-find, for characterising the fixture
offline. Single-link is the only correct linkage here: the recorded wave holds
together through bridge rows, and requiring mutual similarity shatters it.
O(n²) and never on the hot path.

Files:

- `src/worker/match-corpus.ts`



### `test: prove the known facts against the 2026-09-17 recording`

The fixture, copied from argus, and the tests the spec requires before matching
is considered finished.

- `narrative.test.ts` — the port in isolation: normalisation folds case, emoji,
accents, NFKD lookalikes and whole-word filler; the prefix bonus; the metadata
shortcut and its refusal to fire on two empty URIs; the `minLength` guard, with
a test that removes it to prove it is the thing doing the work.
- `fixture.test.ts` — the measurements. Thursday Arena clusters to 27 of 123;
`CUPCAKE`/`thursdayarena` matches at 1.0 on the name alone and would be missed
by a both-fields matcher; the 8 unmatchable-name launches match nothing at all;
the 7 identical-URI groups score 1.0 via metadata; the distribution is bimodal
with a literally empty gap between 5 and 10 matches.
- `match-corpus.test.ts` — the wrapper: self-exclusion, ordering, tie-breaking,
single-link bridging, empty-corpus behaviour.

46 tests. `npm run check` clean.

Files:

- `fixtures/launches-2026-09-17.json`
- `test/narrative.test.ts`
- `test/fixture.test.ts`
- `test/match-corpus.test.ts`



### `docs: record phase 1 implementation notes`

Phase 1 commentary in `NOTES.md`: why the port is enforced verbatim rather than
merely intended to be, why clustering is single-link, the measured numbers and
where they differ from the spec's, and the departures from argus (no zod, trimmed
shapes) with their reasons.

Files:

- `NOTES.md`
- `COMMITS.md`

---



## Phase 2 — the scraper, read-only



### `feat(content): add DOM-independent field parsers`

`src/content/parse.ts`. Compact numbers (`$44.8K` → 44800), compact durations
(`9m` → 540), mint extraction and validation, text and image-URL cleaning.

Written before the DOM capture arrived and unchanged by it, which is the point:
these conversions are the same whatever markup wraps them. The governing rule is
that an unparseable value becomes null and never a guess — a null propagates
honestly, a wrong market cap silently decides whether a coin counts as having
run.

Files:

- `src/content/parse.ts`
- `test/parse.test.ts`



### `feat(content): assemble observations and track extraction rate`

`src/content/observation.ts`. `RawRow` → `PairObservation`, deduplication by
mint, and the per-field extraction tally the spec asks this phase to be judged
on.

Assembly is permissive — a row missing its volume column is still worth storing
— and the tally is what pays for that permissiveness. A redesign does not look
like an error; it looks like every name going null while the mints keep working.
`diagnose()` names that shape specifically, and distinguishes it from the mints
themselves failing, which points at a different file.

Files:

- `src/content/observation.ts`
- `test/observation.test.ts`



### `feat(shared): let a sighting record which Pulse column it came from`

The spec's `source` union predates anyone looking at Pulse. The real screen has
three columns, so `final-stretch` and `migrated` are added.

Not cosmetic: phase 4's run rule is peak market cap over a floor **or** having
been seen in a migrated context, and `migrated` is where that second clause
comes from — the only run signal that does not depend on having had the tab open
at the right moment.

Files:

- `src/shared/types.ts`



### `chore(fixtures): add a scrubber and commit a scrubbed Pulse capture`

`scripts/scrub-dom-fixture.mjs` keeps the feed sections and the ticker strip and
drops scripts, styles, SVG icons, inline base64 images and the surrounding
chrome. It refuses to write output still matching a JWT, bearer token, API key,
email or Next.js hydration payload.

A raw capture is a logged-in session dump carrying the wallet address, balance
and portfolio value, so raw captures are gitignored and only the scrubbed result
is committed. 827KB → 507KB, 30 cards across 4 sections.

Files:

- `scripts/scrub-dom-fixture.mjs`
- `fixtures/axiom-dom/pulse-2026-09-19.html`
- `fixtures/axiom-dom/README.md`
- `.gitignore`



### `feat(content): read Axiom Pulse cards`

`src/content/selectors.ts` and `src/content/scrape.ts`.

**This corrects the spec's first scraper rule.** Anchoring on `a[href*="/meme/"]`
does not find Pulse cards — all 15 such anchors in the capture are in the price
ticker strip, and the 30 cards carry `data-pulse-token-address` instead. The
spec's reasoning transfers to that attribute intact; its literal selector does
not. `mintOf()` falls through four independent witnesses of the mint.

Handles three traps the real markup contains: the `0.0<sub>5</sub>4` fee that
`textContent` flattens into a believable wrong number, a second token image on
migrated cards, and a countdown rendered immediately after the age.

100% extraction on every tracked field across all 30 cards.

Files:

- `src/content/selectors.ts`
- `src/content/scrape.ts`
- `test/scrape.test.ts`



### `feat(content): log observations from a live Axiom tab`

`src/content/index.ts`, `manifest.json`, `scripts/build.mjs`. The phase-2
deliverable: a content script that reads and logs and does nothing else.

MutationObserver scoped to the columns and debounced 250ms, a 5s reconcile
backstop, IntersectionObserver gating the expensive work, and a periodic
extraction report that warns when the scraper degrades. No node state anywhere —
virtualised lists recycle elements, so every pass re-derives from scratch and
keys by mint.

Files:

- `src/content/index.ts`
- `manifest.json`
- `scripts/build.mjs`
- `package.json` (adds `build`, `build:watch`, esbuild)



### `docs: record phase 2 implementation notes`

Files:

- `NOTES.md`
- `COMMITS.md`


### `fix(content): read figures split across several text nodes`

Live extraction reported market cap and volume at 0% while mints held at 100%.
Axiom renders a figure as `["MC", "$", "3.05K"]` on some builds and
`["MC", "$3.17K"]` on the one captured, and the extractor took only the token
after the label.

`joinValue` now accumulates following tokens and keeps the longest run that
forms a valid number — longest, not first, because `["$", "3.05", "K"]` joins at
two into `$3.05` and silently drops the magnitude. Label matching tolerates
case, trailing colons, non-breaking spaces, aliases and the merged one-node
form. Age joins only an exact digits-then-unit pair, so a neighbouring count
cannot fuse onto it. `touchesSub` now checks both directions, so the subscript
guard no longer lets the subscript's own digits through.

The content script prints the offending card's tokens when it detects
degradation, which is what made the second attempt at this a fix rather than
another guess. The live token stream is committed as a regression test verbatim.

Files:
- `src/content/selectors.ts`
- `src/content/index.ts`
- `test/scrape.test.ts`
- `NOTES.md`
- `COMMITS.md`

---

## Phase 3 — corpus and the badge

### `feat(shared): add stored-coin and corpus-meta shapes, and phase 3 thresholds`

`StoredCoin` carries the peaks as maxima across every sighting rather than
latest values, plus `sawMigrated` as an observation distinct from the `ran`
judgement. `CorpusMeta.startedAt` is required, not optional — the honest zero
depends on it.

Thresholds: the $100k run floor (a guess, and the single number that decides
whether the product is useful or noise), a three-day minimum corpus age before
any count is shown, thirty-day retention for coins that never ran, and the
200-candidate cap.

Files:
- `src/shared/types.ts`
- `src/shared/config.ts`

### `feat(worker): classify whether a coin ran, and merge sightings`

`src/worker/ran.ts`. `ran` = peak market cap over the floor **or** seen in the
Migrated column. The second clause is the only run signal that survives not
having been watching.

`mergeSighting` is pure and re-derives `ran` from stored fields, so moving the
floor re-judges the whole corpus without a migration.

Files:
- `src/worker/ran.ts`
- `test/ran.test.ts`

### `feat(worker): generate candidates from IndexedDB indexes`

`src/worker/index-store.ts`. Trigrams, phash bands, and the union-dedupe-cap.

**Deviates from the spec's storage shape**: the spec's `{ key, mints[] }` rows
make every insert a read-modify-write of an unbounded array. These are native
IndexedDB indexes instead — same three lookup tables, maintained incrementally
by the engine. Exact keys are queried before trigrams so the cap truncates the
weakest signal first.

Files:
- `src/worker/index-store.ts`

### `feat(worker): store the corpus in IndexedDB`

`src/worker/corpus.ts`. The `coins` and `meta` stores, batched writes, candidate
retrieval, and retention that never evicts a coin that ran.

No corpus state in module scope — MV3 evicts the worker every ~30s idle, and a
count from a stale cache is still a number with nothing to say it is wrong. Only
the database handle persists, and `withDb` reopens it transparently.

`CorpusSource` is the seam the spec asks for, read-only because writes are local
by nature.

Files:
- `src/worker/corpus.ts`
- `test/corpus.test.ts`

### `feat(worker): count prior runs and route messages`

`src/worker/lookup.ts` assembles the badge's two numbers and gates them on
corpus age. `src/worker/index.ts` routes messages and runs retention on
`chrome.alarms` rather than a timer, which would only fire while the worker
happened to be alive.

Files:
- `src/worker/lookup.ts`
- `src/worker/index.ts`
- `src/shared/messages.ts`

### `feat(content): paint the badge in a shadow-DOM overlay`

`src/content/overlay.ts`. One fixed layer, positioned against
`getBoundingClientRect()`, rAF-throttled, reads batched before writes. The
page's DOM is never modified, and there is a test asserting the card's
`outerHTML` is unchanged after badging.

Below the minimum corpus age the badge shows the age instead of a number, and
the popover restates the corpus age and the undercount caveat every time.

Files:
- `src/content/overlay.ts`
- `test/overlay.test.ts`

### `feat(content): record observations and request counts`

Wires the phase-2 loop to the worker: observe, then look up, then badge. Node
bindings are re-derived after the round-trip because the virtualiser may have
recycled every card in between.

Files:
- `src/content/index.ts`
- `manifest.json`
- `scripts/build.mjs`

### `docs: record phase 3 implementation notes`

Files:
- `NOTES.md`
- `COMMITS.md`

### `fix(content): stop a badge outliving the coin it belongs to`

A stale badge could appear above a newly-inserted coin — the virtualised node
recycling failure, where coin A's count is shown against coin B.

Two causes, neither of them speed. Position was reconciled only on scroll, but
New Pairs inserts at the top and shifts rows down via a DOM mutation, so badges
sat at pixel positions that now belonged to the next coin down. And nothing
re-checked which coin a card held, while the overlay keeps a node reference that
recycling can repoint.

Position and data now reconcile on different cadences: repositioning is a rect
read and a style write, so it runs on every mutation and resize (rAF-throttled),
while scrape and lookup stay debounced at 250ms. `reconcile()` additionally
drops any badge whose card no longer holds its mint, via an injected
`verifyMint` that abstains when it cannot tell.

Also fixes the overlay tests, which jsdom's lack of layout had made partly
vacuous: every rect was zero, so the zero-rect guard skipped every card and no
badge existed to assert on. They now stub a layout box, assert the badge exists,
and use the new `Overlay.flush()` instead of racing an animation frame. The
recycling test was verified by mutation — it fails with the guard removed.

Files:
- `src/content/overlay.ts`
- `src/content/selectors.ts`
- `src/content/index.ts`
- `test/overlay.test.ts`
- `NOTES.md`
- `COMMITS.md`

---

## Phase 4 — images

### `feat(worker): compute perceptual hashes`

`src/worker/phash.ts`. 64-bit DCT pHash: 32x32 grayscale, separable 2D DCT,
low-frequency 8x8 block, median threshold excluding DC, 16 hex characters.

Fills in the field argus declared and never computed (`enrich.ts`:
`imagePhash: null, // computed at step 9`). It matters more here than there,
because Pulse exposes no metadata URI, so the identical-metadata shortcut never
fires and the image is the only way to notice two differently-named coins are
the same thing.

Hashing runs in the worker, not the page: `drawImage` with a cross-origin image
taints the canvas and `getImageData` then throws, and nothing in the content
script can undo a taint decided when the image was fetched. Fetch,
`createImageBitmap` and `OffscreenCanvas` in the worker avoid it entirely.

The variance floor rejects flat images. The spec's stated reason — that they
collide with each other — turns out not to be what happens: a solid image's
non-DC coefficients are floating-point residue near 1e-12, so the hash is
arbitrary rather than colliding. The floor stands for the better reason, and the
comment and test now say so.

Files:
- `src/worker/phash.ts`
- `src/shared/config.ts`
- `test/phash.test.ts`

### `feat(worker): store hash verdicts and populate the band index`

`phashState` on the stored coin distinguishes `degenerate` (permanent — a flat
picture stays flat) from `unavailable` (retryable — a dead link may not be).
Collapsing them would mean re-fetching every flat image forever or abandoning a
coin over one CDN hiccup.

`pendingImageWork` offers only coins on screen that still need a hash;
`recordPhashes` writes verdicts including failures, because an unrecorded
failure is indistinguishable from never having tried. The `phashBands` index
fills as a side effect of that write.

Files:
- `src/shared/types.ts`
- `src/worker/corpus.ts`
- `src/worker/ran.ts`
- `test/corpus.test.ts`

### `feat(worker): match on images as well as text`

An image match alone is sufficient — the renamed clone is the case this phase
exists for. Text alone still needs 0.90; text corroborating an image only needs
0.72, argus's looser bar for exactly this situation.

Candidates are scored at both bars rather than once at the looser one, because
`matchedOn` means "what was recognisable" and a strict match must not report a
looser recognition than it earned.

Hashing is fired and not awaited: it is network-bound, and the badge can produce
its number without it.

Files:
- `src/worker/lookup.ts`
- `src/worker/index.ts`
- `manifest.json`

### `feat(content): show image evidence in the popover`

`identical image` or `image 4/64 bits apart`, and nothing at all when either
side has no hash — a failed hash is not a statement about whether two pictures
match, and "same image" claims more than 10 bits out of 64 supports.

Files:
- `src/content/overlay.ts`
- `test/overlay.test.ts`

### `perf: measure the cost of hashing`

`npm run bench:phash`. Full hash 0.10 ms/image; 40 visible rows 4.0 ms of CPU;
31 launches/min sustained 0.0052% of one core. CPU is not the constraint, fetch
and decode are — which is what the concurrency cap addresses.

The first run reported a figure 1000x too high by converting ms/second to a
percentage without dividing by 1000. Fixed, with the arithmetic spelled out.

Files:
- `scripts/bench-phash.ts`
- `package.json`

### `docs: record phase 4 implementation notes`

Files:
- `NOTES.md`
- `COMMITS.md`

---

## Phase 5 — seeding

### `feat(worker): import a recording into the corpus`

`src/worker/import.ts`. Validation plus a batched write, and the project's only
edge against genuinely untrusted data — a file the user picked, from a recorder
that may be any version or none. Hand-rolled rather than zod, which is the trade
the type contract already describes.

Permissive about everything except the mint: a blank name is a real launch and
the matcher's `minLength` guard already handles it. Duplicates within one file
are dropped, because a recording repeats frames after a reconnect.

`lastSeen` is set to the import moment, not the recorded launch time. Retention
drops never-ran coins by `lastSeen` and every imported coin is never-ran, so the
launch time would have had the whole seed deleted by the first sweep minutes
after import. `firstSeen` keeps the real launch date for display.

Seeded coins can never count as having run — the feed carries no market cap and
no migration — so an import grows the total and never the ran count. Asserted
end to end.

Files:
- `src/worker/import.ts`
- `src/worker/corpus.ts` (extracts `withCoinsWrite`, shared with the observe path)
- `src/shared/types.ts` (adds the `imported` source)
- `test/import.test.ts`

### `feat(scripts): record launches from PumpPortal`

`scripts/record-launches.ts`, `npm run record`. A port of argus's launch stream
and the parts of `reconnect.ts` it needs, reduced to what a recorder wants: no
Redis, no pino, no event bus, no zod.

The silence watchdog is the reason it is a port rather than twenty lines of
WebSocket. At ~31 launches a minute, silence means the socket died, not that
nobody launched — and a recorder without one looks healthy while writing
nothing. Verified against two throwaway servers: one that kills the socket
mid-stream, and one that connects and then stays mute.

Writes newline-delimited JSON. A run measured in days will be killed, and a
truncated JSON array parses as nothing.

Files:
- `scripts/record-launches.ts`
- `package.json` (adds `record`, `ws`)

### `feat(options): add an options page for seeding and corpus status`

The first UI beyond the badge, and unavoidable: a content script cannot open a
file picker and the worker has no DOM.

Shows coin count, corpus age, and whether badges are live — the last of which
distinguishes "the age gate is holding numbers back" from "nothing is being
stored", which need opposite responses. `badgesReady` comes from the worker so
the age gate has one definition rather than two that can drift apart.

Imports chunk at 2,000 launches per message: `sendMessage` serialises the whole
payload, and each batch is one IndexedDB transaction.

Files:
- `src/options/index.html`
- `src/options/index.ts`
- `src/shared/messages.ts`
- `src/worker/index.ts`
- `manifest.json`

### `build: emit IIFE for the content script and ESM for the rest`

The worker is `"type": "module"` and the options page loads as a module, but MV3
injects a content script as a classic script, where an ESM bundle fails at load
with an error that points at the file rather than the format.

Files:
- `scripts/build.mjs`

### `docs: record phase 5 implementation notes`

Files:
- `NOTES.md`
- `COMMITS.md`
