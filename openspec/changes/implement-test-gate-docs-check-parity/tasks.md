## 1. Inventory and seams

- [ ] 1.1 Confirm current presence of `scripts/generate-docs.mjs`, `docs:check` / `docs:generate` scripts, and whether `package.json` `ci` already includes docs freshness (coordinate with #597 state on the integration branch)
- [ ] 1.2 Map the post-implementation call chain (`resumeFromImplementing` → format/test gates → push → createPr) and the existing `build-side-effects` / format-gate patterns to choose the regenerate-and-fold insertion point
- [ ] 1.3 Define injectable deps for docs generate, docs check, dirtiness, and commit so unit tests need no real subprocess/git/network

## 2. CI spine and drift-guard (`test-gate-ci-parity`)

- [ ] 2.1 When the docs generator is present, ensure root `package.json` wires `docs:check` / `docs:generate` and includes the check in the `ci` script after the mirror check (or equivalent documented position)
- [ ] 2.2 Add a drift-guard test that fails if the generator is present but `ci` no longer invokes docs freshness
- [ ] 2.3 Update README and/or CLAUDE.md / AGENTS.md build guidance to name docs freshness as part of `npm run ci` when the generator is present

## 3. Pre-PR docs freshness enforcement (`docs-freshness-gate`)

- [ ] 3.1 Implement presence detection (`scripts/generate-docs.mjs` and/or `docs:check` script)
- [ ] 3.2 Implement regenerate-and-fold: on clean worktree, run generate write mode; if dirty, commit regenerated outputs with conventional `docs:` message + issue reference; re-run `--check`
- [ ] 3.3 Wire enforcement into the post-implementation path so a red docs check blocks before `createPr` / successful advance (first open and resume)
- [ ] 3.4 On exhausted or impossible heal, block with reason naming stale file(s); never open/update PR while check is red
- [ ] 3.5 Confirm interaction with format/test gate clean-tree rules and, if needed, `isPipelineInternalCommit` for docs-regenerate commits (extend only if required for convergence)

## 4. Implementing prompt contract

- [ ] 4.1 Extend the implementing docs instruction (and/or generator-aware appendix) to require regenerate+commit of all generator outputs when the generator is present or the change is docs-primary / generator-touching
- [ ] 4.2 Name the check command (`npm run docs:check` / `generate-docs --check`) in that instruction when the surface exists
- [ ] 4.3 Add or extend a prompt-loader / prompt rendering test so the language cannot silently disappear

## 5. Regression tests

- [ ] 5.1 Unit test: injected failing docs check on post-implementation path → block, `createPr` not called
- [ ] 5.2 Unit test: auto-heal path regenerates, commits, re-checks green → PR path may proceed (subject to other gates)
- [ ] 5.3 Prove bite: temporarily remove pre-PR enforcement and confirm the regression fails, then restore
- [ ] 5.4 Cover inert path when generator is absent (no extra generate/check, no false block)

## 6. Packaging and verification

- [ ] 6.1 If `core/` sources change, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [ ] 6.2 Run `openspec validate implement-test-gate-docs-check-parity` and fix structural issues
- [ ] 6.3 Run `npm run ci` from the repo root and fix failures
- [ ] 6.4 Confirm proposal acceptance-criteria checkboxes are all falsifiable against the landed behavior
