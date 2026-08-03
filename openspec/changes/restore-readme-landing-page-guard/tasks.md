## 1. README landing-page contract checker

- [ ] 1.1 Add a pure README landing-page contract checker (line budget `< 400`, required relative links to `docs/cli.md` / `docs/config.md` / `docs/concepts.md`, and no full hand-maintained CLI/config inventory shape) with stable diagnostic codes
- [ ] 1.2 Unit-test the checker with fixtures: compliant lean README passes; over-budget fails; missing companion link fails; optional inventory-shape fail
- [ ] 1.3 Add a #793-shaped fixture (lean prefix + large monolithic append) that fails the checker and bites if enforcement is removed

## 2. Wire into docs check / freshness surface

- [ ] 2.1 Invoke the checker from `scripts/generate-docs.mjs --check` (and any `docs:check` path) so failures exit non-zero with README/landing-page diagnostics
- [ ] 2.2 Confirm generator write mode does not auto-truncate or rewrite README as a silent heal; generator-only heal cannot greenwash an over-budget README
- [ ] 2.3 Extend docs-freshness / `ci-docs` related tests so a red landing-page contract blocks the same pre-PR class of outcomes as stale generated docs (injectable seams; no real network/git as sole pass path)

## 3. Restore lean README artifact

- [ ] 3.1 Reconstruct root `README.md` to the #597 lean landing-page contract (`< 400` lines, companion links, no full inventories)
- [ ] 3.2 Preserve legitimate post-#790 landing-page edits (at minimum stage-inventory accuracy from #626 and install/packaging accuracy from #635) without reintroducing the #793 monolith append
- [ ] 3.3 Run `npm run docs:check` / `node scripts/generate-docs.mjs --check` and confirm green on the restored tree

## 4. Repair / restack fail-closed control

- [ ] 4.1 Inventory post-restack / merge-queue repair re-gate and pre-merge/surgical-fix success paths; ensure a landing-page docs-check failure cannot be treated as re-gate eligible or gate-passed advance
- [ ] 4.2 Add a unit/fixture regression: #793-shaped README after claimed surgical or conflict repair → fail-closed / non-eligible (bites if assertion removed)
- [ ] 4.3 Confirm no review-policy threshold, merge-authority, or stage-machine semantic changes; control remains docs-check / eligibility fail-closed only

## 5. Validation and gate

- [ ] 5.1 Run `openspec validate restore-readme-landing-page-guard` and fix structural issues
- [ ] 5.2 Run `npm run ci` from repo root; if `core/` changes, run `node scripts/build.mjs` and commit `plugin/` in the same change
- [ ] 5.3 Confirm acceptance criteria in `proposal.md` are met with evidence (line count, check red/green cases, repair fail-closed test)
