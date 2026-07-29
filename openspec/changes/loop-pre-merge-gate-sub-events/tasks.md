## 1. Schema and mapping inventory

- [ ] 1.1 Confirm no competing progress kind name already exists on main or an active #611 change; adopt `loop_item_progress` or the single shared name if already reserved
- [ ] 1.2 Inventory real advance pre-merge event shapes (`gate_result`, `review_verdict`, CI waiting/pass/fail, auto-fix markers, `blocker_set`) from code and/or dogfood fixtures — do not invent `gh` field names
- [ ] 1.3 Document the advance-event → `{ domain, step, status, detail }` mapping table next to the mirror implementation (constant or pure function)

## 2. Mirror helper

- [ ] 2.1 Add a pure (or deps-injected) helper under `core/scripts/loop/` that, given linkage join keys + a slice of new advance events + last-emitted fingerprints, returns zero or more `loop_item_progress` payloads
- [ ] 2.2 Implement spam control: at most one `ci`/`waiting` per continuous wait stretch; idempotent fingerprints for identical outcomes
- [ ] 2.3 Implement catalog coverage: `ci`, `openspec_archive`, `delta_review`, `autofix`, `terminal` with required statuses from the design
- [ ] 2.4 Ensure every payload includes `item_id`, `pipeline_run_id`, and absolute `events` when known

## 3. Supervisor integration

- [ ] 3.1 During linked advance wait (after `loop_item_advance_linked`, until finish/exit), arm the mirror against the advance `events` path via injected seams
- [ ] 3.2 Append progress via existing loop `appendEvent`; treat append failures as non-fatal to the advance child
- [ ] 3.3 Stop mirroring on `loop_item_advance_finished` / child exit; do not invent progress without confirmed linkage

## 4. Unit tests

- [ ] 4.1 Unit tests for mapping + emit conditions with fake advance sequences (no network/git/subprocess): CI waiting once / pass / fail+classification
- [ ] 4.2 Tests for OpenSpec archive pass/skipped/fail; delta started/approve/needs_attention+blocking_count; autofix attempted/success/exhausted; terminal blocked/advanced
- [ ] 4.3 Regression: three identical waiting polls → exactly one waiting progress event
- [ ] 4.4 Regression: re-read same gate_result → no duplicate progress line
- [ ] 4.5 Supervisor/integration-style test with fake dispatch linkage + advance event feed proving join keys match linkage

## 5. Host docs and packaging

- [ ] 5.1 Update `hosts/claude/SKILL.md` material loop events + note that pre-merge gate outcomes appear on the loop stream; keep optional advance follow for full fidelity
- [ ] 5.2 Mirror equivalent guidance in `hosts/codex/SKILL.md`
- [ ] 5.3 Run `node scripts/build.mjs` so `plugin/` skill/command mirrors stay in sync when packaging sources change

## 6. Validate and CI

- [ ] 6.1 `openspec validate loop-pre-merge-gate-sub-events` (and `--all` if required by local habit)
- [ ] 6.2 `npm run ci` from repo root green
