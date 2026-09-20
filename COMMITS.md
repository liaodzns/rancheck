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
