## Why

The factory opened #597 / PR #711 after implement + test-gate "success," then blocked at pre-merge because CI failed `docs:check` on a stale `CHANGELOG.md` while unit tests were green. Pre-merge is a late, expensive place to learn that local verification was weaker than CI — especially for a docs-generator change whose product contract *is* freshness of generated artifacts. Implement and the local test-gate must run the same docs-freshness check CI runs, auto-heal or fail closed, and never open or update a PR with a failing docs check.

## What Changes

- Treat **docs freshness** (`npm run docs:check` / `node scripts/generate-docs.mjs --check`, or the docs portion of `npm run ci`) as a **first-class pre-PR gate** for this repo when the docs generator is present — same class of failure as a stale `plugin/` mirror.
- Require that this repo's full CI command (`npm run ci`, already used as `test_gate.command`) includes the docs-freshness step whenever the generator scripts exist, so a green local test-gate implies a green CI docs check for committed artifacts.
- On docs-check failure before PR open, the pipeline SHALL **auto-heal** (regenerate → commit regenerated outputs → re-check) within the existing bounded fix budget, **or** fail implement/test-gate with a clear reason naming the stale file(s) — **never** create or update a PR while docs check is red.
- Strengthen the implementing verification contract / prompts so generator-touching and docs-primary changes regenerate and commit all generator outputs in the same change as the generator code.
- Add a **regression test** that a deliberate stale generated docs artifact (e.g. `CHANGELOG.md`) fails at implement verification / test-gate **before** PR creation, and proves the test bites without the fix.

No auto-merge path. Not **BREAKING** for consumer repos that do not ship a docs generator.

## Capabilities

### New Capabilities

- `docs-freshness-gate`: Pre-PR enforcement of the repo's docs generator freshness check (when present): run the same check CI runs, auto-heal or fail closed before advertising implement success or opening/updating a PR, implement-prompt contract for generator outputs, and a regression path for deliberate stale generated docs.

### Modified Capabilities

- `test-gate-ci-parity`: Extend the full-CI-surface contract so this repo's `npm run ci` (and thus `test_gate.command`) includes the docs-freshness step whenever the docs generator is part of the repo, with a drift-guard test parallel to the existing OpenSpec / mirror / install-smoke wiring assertions.

## Acceptance criteria

- [ ] When the repo has a docs generator / `docs:check` surface, implement verification and the local test-gate both run that check (directly or via `npm run ci`) **before** advertising implement success or opening/updating the PR.
- [ ] On docs-check failure, the stage either regenerates outputs, commits them, and re-checks until green within the bounded budget, **or** blocks with a reason that names the stale file(s) — and **never** opens or updates a PR while docs check is red.
- [ ] A deliberate stale generated docs artifact (e.g. `CHANGELOG.md` or equivalent) fails in a unit/fixture path at test-gate / implement verification **before** any PR-create call; the test fails if that pre-PR failure path is removed.
- [ ] Implementing prompt / verification contract for docs-generator or docs-primary work explicitly requires regenerating and committing all generator outputs in the same change as the generator code.
- [ ] This repo's `package.json` `ci` script includes the docs-freshness step when the generator is present; a drift-guard test fails if that step is dropped while the generator remains.
- [ ] Pre-merge is not the first place a stale generated-docs failure is discovered for paths covered by the local docs check (parity with the #597 / PR #711 failure class).

## Impact

- `core/scripts/testgate.ts` and/or post-implement gate orchestration (`stages/format-gate.ts`, `stages/planning.ts` post-implementation path) — ensure docs freshness is enforced before push/PR.
- Possible small auto-heal path for docs regenerate+commit (may reuse format-gate / fix-loop / build-side-effects patterns; design decides).
- `core/scripts/prompts/implementing.md` / `prompts/index.ts` docs instruction — generator-output regenerate+commit language when applicable.
- `package.json` — when generator is present, `ci` / `docs:check` wiring parity with CI.
- `core/test/` (and/or `scripts/*.test.mjs`) — regression + drift-guard tests; injectable deps only (no real network/git in unit tests).
- Living specs: new `docs-freshness-gate`; delta on `test-gate-ci-parity`.
- Does **not** hand-fix #597's current PR; does **not** replace human CI for non-docs failures; does **not** change loop resume (#712) or OpenSpec archive skip-then-block (#714).
