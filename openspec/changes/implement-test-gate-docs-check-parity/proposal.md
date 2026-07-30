## Why

The factory opened #597 / PR #711 after implement + test-gate "success," then blocked at pre-merge because CI failed `docs:check` on a stale `CHANGELOG.md` while unit tests were green. Pre-merge is a late, expensive place to learn that local verification was weaker than CI — especially for a docs-generator change whose product contract *is* freshness of generated artifacts. Implement and the local test-gate must run the same docs-freshness check CI runs, auto-heal or fail closed, and never open or update a PR with a failing docs check.

## What Changes

- Enforce **docs freshness** on the pipeline's **generic** post-implementation worktree path when a docs generator is detected (`scripts/generate-docs.mjs` and/or a `docs:check` script that invokes it) — consumer repos with a generator get the same pre-PR protection; generator-absent repos stay inert.
- Define one explicit pre-PR order: after implement/fix commits and format/test convergence → docs check → optional one-shot auto-heal → re-check → re-run format+test on new HEAD if healed → only then push / create-or-reuse PR → advertise implement success.
- On docs-check failure: **auto-heal safely** (clean-tree attribution, generator-only dirt, issue-referenced `docs:` commit, at most one attempt) **or** fail closed with preserved check output and real stale path names when parseable — **never** create **or** push/update a PR while docs check is red.
- Require this repo's full CI command (`npm run ci`, already `test_gate.command`) includes the docs-freshness step whenever the generator exists (structural drift-guard), so green local test-gate implies green CI docs for committed artifacts on agent-pipeline.
- Strengthen implementing prompts via **pre-implement** detection (generator present + `steps.docs`), not a post-hoc "touches paths" diff.
- Add seam-based regressions proving ordering, both PR surfaces, auto-heal positives/negatives, and bite without the fix.
- Edit `core/`, regenerate `plugin/` via `node scripts/build.mjs` — never hand-edit the mirror.

No auto-merge path. Not **BREAKING** for consumer repos that do not ship a docs generator.

## Capabilities

### New Capabilities

- `docs-freshness-gate`: Pre-PR enforcement of the repo's docs generator freshness check (when present): run the same check CI runs, auto-heal or fail closed before advertising implement success or opening/updating a PR, implement-prompt contract for generator outputs, and a regression path for deliberate stale generated docs.

### Modified Capabilities

- `test-gate-ci-parity`: Extend the full-CI-surface contract so this repo's `npm run ci` (and thus `test_gate.command`) includes the docs-freshness step whenever the docs generator is part of the repo, with a drift-guard test parallel to the existing OpenSpec / mirror / install-smoke wiring assertions.

## Acceptance criteria

- [ ] With docs-generator-present, the post-implementation path runs the docs freshness check **before** push and before `createPr` / existing-PR advance, and only advertises implement success after that sequence (including re-running format+test when a heal commit lands).
- [ ] On docs-check failure, the stage either auto-heals once (clean tree → generate → commit generator-only dirt with issue ref → re-check → re-gate) **or** blocks with preserved check output and stale file name(s) when parseable — never inventing names; never opens or pushes/updates a PR while docs check is red.
- [ ] Seam tests prove: ordering (docs check before push/`createPr`); red docs blocks both new-PR and existing-PR resume push; auto-heal success and negatives (no change, generate fail, re-check red, dirty tree); generator absent invokes no docs command.
- [ ] A deliberate stale / injected red docs check fails before `createPr` in a unit/fixture path; removing the pre-PR enforcement makes that test fail.
- [ ] Implementing prompt (generator present + `steps.docs`) requires regenerate+commit of generator outputs and names the check command; no generator → no fake regenerate commands.
- [ ] This repo's `package.json` `ci` includes docs freshness when the generator is present; a **structural** drift-guard fails if that step is dropped while the generator remains.
- [ ] `core/` edits are mirrored via `node scripts/build.mjs` (no hand-edited `plugin/`); `openspec validate` and `npm run ci` pass.

## Impact

- New `core/scripts/docs-freshness.ts` (or equivalent) + wiring in `stages/planning.ts` (`resumeFromImplementing`) and fix post-gate path that can push — enforcement before push/PR, not only agent-pipeline `ci`.
- Pattern reuse of `build-side-effects.ts` clean-tree fold; optional re-entry into `runFormatAndTestGates` after heal.
- `core/scripts/prompts/index.ts` docs instruction — generator-aware language via pre-implement detection.
- `package.json` — when generator is present, `ci` / `docs:check` wiring parity with CI + structural drift-guard test.
- `core/test/` — ordering, both PR surfaces, auto-heal matrix, prompt, drift-guard; injectable deps only.
- Living specs: new `docs-freshness-gate`; delta on `test-gate-ci-parity`.
- Regenerated `plugin/` via `scripts/build.mjs`.
- Does **not** hand-fix #597's current PR; does **not** replace human CI for non-docs failures; does **not** change loop resume (#712) or OpenSpec archive skip-then-block (#714).
