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
