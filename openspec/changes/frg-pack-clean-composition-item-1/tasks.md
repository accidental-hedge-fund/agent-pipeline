## 1. Provenance note

- [ ] 1.1 Add a single-line (or single-bullet) provenance note under `docs/`
      (preferred: `docs/factory-reliability-gate-runbook.md` near pack /
      `clean-item-throughput` content) **or** a one-line README note in the FRG /
      factory-gate section
- [ ] 1.2 Wording MUST name: clean composition pack item **1**, release
      **1.29.1**, and that the item exists for FRG `clean-item-throughput` /
      factory-gate pack composition (no product or scoring claim)
- [ ] 1.3 Confirm the diff is docs/comment-only: no edits to
      `core/scripts/factory-reliability-gate.ts`, release preflight, scoreboard,
      thresholds, or product feature code

## 2. OpenSpec hygiene

- [ ] 2.1 Keep this change folder complete (`proposal.md`, `design.md`,
      `tasks.md`, `specs/factory-reliability-gate/spec.md`)
- [ ] 2.2 Run `openspec validate frg-pack-clean-composition-item-1` and fix any
      structural errors
- [ ] 2.3 Do not create a second OpenSpec change for the same issue

## 3. Verification

- [ ] 3.1 Run `npm run ci` from the repo root and ensure green
- [ ] 3.2 Spot-check acceptance criteria in `proposal.md` against the landed
      diff (provenance present; no FRG scoring code changes)
- [ ] 3.3 Open/advance the PR so the issue can reach
      `pipeline:ready-to-deploy` without an engine-class block (pack throughput
      outcome; human merge remains out of band)
