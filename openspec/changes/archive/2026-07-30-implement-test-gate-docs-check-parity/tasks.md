## 1. Inventory and seams

- [x] 1.1 Confirm current presence of `scripts/generate-docs.mjs`, `docs:check` / `docs:generate` scripts, and whether root `package.json` `ci` already includes docs freshness (coordinate with #597 state on the integration branch)
- [x] 1.2 Map `resumeFromImplementing` (gates → push → createPr/reuse) and the fix post-gate path; confirm insertion **after** format+test convergence and **before** push/`createPr`
- [x] 1.3 Add injectable deps for detect, docs check, docs generate, porcelain status, stage/commit, and gate re-run so unit tests need no real subprocess/git/network

## 2. CI spine and drift-guard (`test-gate-ci-parity`)

- [x] 2.1 When the docs generator is present, ensure root `package.json` wires `docs:check` / `docs:generate` and includes the check in the `ci` script after the mirror check (or equivalent documented position)
- [x] 2.2 Add a **structural** drift-guard (JSON-parse `package.json`, walk `scripts.ci` / transitive script targets) that fails if the generator is present but `ci` no longer reaches docs freshness — not substring-only
- [x] 2.3 Update README and/or CLAUDE.md / AGENTS.md build guidance to name docs freshness as part of `npm run ci` when the generator is present

## 3. Pre-PR docs freshness enforcement (`docs-freshness-gate`)

- [x] 3.1 Implement presence detection: `scripts/generate-docs.mjs` **or** `docs:check` script whose value invokes that generator; arbitrary unrelated `docs:check` does **not** activate
- [x] 3.2 Implement check → (optional one-shot auto-heal) → re-check:
  - clean-tree precondition before generate (build-side-effects pattern)
  - generate write mode; commit only generator-attributable dirt with `docs: regenerate… (#N)`
  - no commit when generate no-ops or pre-tree was dirty
  - preserve stdout/stderr; extract stale paths when parseable; otherwise report command failure without inventing file names
- [x] 3.3 Wire into generic post-implementation path (`resumeFromImplementing`) and the fix path that can push an updated head so red docs blocks **before** push and before `createPr` / existing-PR advance
- [x] 3.4 After a successful heal commit, re-run format+test gates on the new HEAD before push/PR
- [x] 3.5 On exhausted or impossible heal, block with reason naming stale file(s) when available; never open/update PR while check is red
- [x] 3.6 Confirm interaction with clean-tree rules and `isPipelineInternalCommit` for docs-regenerate commits (extend only if required for convergence, with tests)

## 4. Implementing prompt contract

- [x] 4.1 Pre-implement applicability: generator present (worktree detection) + `steps.docs` / `docsEnabled` — **not** post-hoc "touches paths" from a missing diff
- [x] 4.2 Extend the implementing docs instruction to require regenerate+commit of all generator outputs and name `npm run docs:check` / `generate-docs --check` when the surface exists
- [x] 4.3 When generator absent, do not require non-existent regenerate commands
- [x] 4.4 Prompt-loader / rendering test so the language cannot silently disappear

## 5. Regression tests

- [x] 5.1 Ordering: call log proves docs check before push/`createPr` (first open and existing-PR resume)
- [x] 5.2 Red docs → block; **neither** `createPr` nor successful push; existing-PR resume also fails closed
- [x] 5.3 Auto-heal: generated-only delta commits and proceeds; re-runs gates; then PR path may continue
- [x] 5.4 Auto-heal negatives: generator no change; generator fails; re-check remains red; unrelated dirty files prevent automatic commit
- [x] 5.5 Generator absent → no docs command invoked
- [x] 5.6 Deliberate stale / injected red check fails before `createPr`; prove bite if pre-PR enforcement is removed
- [x] 5.7 Structural `ci` ↔ generator drift-guard

## 6. Packaging and verification

- [x] 6.1 Edit `core/` only; run `node scripts/build.mjs`; include regenerated `plugin/` in the same commit — never hand-edit `plugin/`
- [x] 6.2 Run `openspec validate implement-test-gate-docs-check-parity` (and `openspec validate --all` before done)
- [x] 6.3 From `core/`: `npm test`. From root: `npm run ci`. When generator present: `npm run docs:check` and/or `node scripts/generate-docs.mjs --check`
- [x] 6.4 Confirm proposal acceptance-criteria checkboxes are all falsifiable against the landed behavior
