## 1. Provenance note

- [x] 1.1 Add a minimal checked-in provenance note under `docs/` (preferred: short line in `docs/factory-reliability-gate-runbook.md`) and/or a one-line `README.md` note naming FRG pack clean composition item 2 for v1.29.1 / issue #750
- [x] 1.2 Confirm the diff is docs/comment-only plus this OpenSpec change — no product code, no FRG scoring/driver edits, no auto-merge or release-tag changes

## 2. Verification

- [x] 2.1 Run `openspec validate frg-pack-clean-composition-item-2` and fix any structural issues
- [x] 2.2 Run `npm run ci` from the repo root and ensure green
- [x] 2.3 Spot-check acceptance criteria in `proposal.md` against the landed diff

## 3. Pipeline outcome (pack scoring)

- [ ] 3.1 Open the PR for this branch and advance to `pipeline:ready-to-deploy` without an engine-class block (Layer B clean composition outcome for item 2)
- [ ] 3.2 At pre-merge, archive the OpenSpec change (or confirm archive path) so `openspec validate --all` remains green
