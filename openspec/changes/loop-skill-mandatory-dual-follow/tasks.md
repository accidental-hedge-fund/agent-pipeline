## 1. Host skill: mandatory dual-follow prose

- [ ] 1.1 In `hosts/claude/SKILL.md` §4b.d, replace “Optional: follow…” / “optionally follow” with **SHALL/must** dual-follow after `loop_item_advance_linked` (or equivalent) publishes `pipeline_run_id` / `events`
- [ ] 1.2 Document preferred follow command `pipeline logs <advance-run-id> --events --follow` (or packaged `pipeline.mjs` path) and absolute `events` path as acceptable target
- [ ] 1.3 Document follow lifecycle: arm on linkage; switch/add on new item link; stop prior advance follow on terminal advance outcome; keep loop follow until terminal loop outcome / supervisor exit
- [ ] 1.4 List material advance kinds (`stage_start`, `stage_complete`, `pr_created`, `review_verdict`, `gate_result`, `blocker_set`, `run_complete`) and CI-poll spam suppression
- [ ] 1.5 Document loop-only insufficiency for mid-item stage progress until #611; note loop-only still valid for schedule/hold/terminal loop kinds; cross-link #611 and #682; note demotion MAY land with #611
- [ ] 1.6 Mirror the same contract in `hosts/codex/SKILL.md` with Codex-appropriate tooling names

## 2. Drift-guard

- [ ] 2.1 Add or extend a unit test (e.g. near loop packaging / skill prose guards) that fails if post-linkage advance follow is described only as optional without mandatory dual-follow language in Claude and Codex host skills
- [ ] 2.2 Assert pre-linkage “not required before linkage exists” wording (if present) does not trip the guard
- [ ] 2.3 Prove the guard bites: temporarily reintroduce optional-only §4b.d wording and confirm the test fails, then restore the fix

## 3. Mirror, OpenSpec, CI

- [ ] 3.1 Run `node scripts/build.mjs` so `plugin/` skill mirror matches host sources; commit regenerated `plugin/` with the skill change
- [ ] 3.2 Run `openspec validate loop-skill-mandatory-dual-follow` and fix structural issues
- [ ] 3.3 Run `npm run ci` from repo root and fix failures until green
