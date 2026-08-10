## 1. Provenance artifact

- [ ] 1.1 Choose one form: (A) single-line/bullet provenance note under `docs/`
      (preferred: `docs/factory-reliability-gate-runbook.md` near pack /
      `clean-item-throughput` content) **or** a one-line README note in the FRG /
      factory-gate section; **or** (B) a run-scoped JSON fixture under
      `core/test/fixtures/frg/` (for example
      `core/test/fixtures/frg/v1.34.0/clean-composition-item-1.json`)
- [ ] 1.2 Artifact wording/fields MUST name: clean composition pack item **1**,
      release **1.34.0**, and that the item exists for FRG `clean-item-throughput`
      / factory-gate pack composition (no product or scoring claim)
- [ ] 1.3 If form (B): add a hermetic `node --test` unit test that loads only that
      fixture path and asserts `release_version === "1.34.0"`; prove the assertion
      bites by temporary mutation during development
- [ ] 1.4 Confirm the implementation diff does not edit
      `core/scripts/factory-reliability-gate.ts`, release preflight, scoreboard,
      thresholds, or product feature code

## 2. OpenSpec hygiene

- [ ] 2.1 Keep this change folder complete (`proposal.md`, `design.md`,
      `tasks.md`, `specs/factory-reliability-gate/spec.md`)
- [ ] 2.2 Run `openspec validate frg-pack-clean-composition-item-1-v1-34-0` and
      fix any structural errors
- [ ] 2.3 Do not create a second OpenSpec change for issue #959

## 3. Verification

- [ ] 3.1 Run `npm run ci` from the repo root and ensure green
- [ ] 3.2 Spot-check acceptance criteria in `proposal.md` against the landed
      diff (provenance present; no FRG scoring code changes)
- [ ] 3.3 Open/advance the PR so the issue can reach
      `pipeline:ready-to-deploy` without an engine-class block (pack throughput
      outcome; human merge remains out of band; FRG may close without merge after
      pack pass)
