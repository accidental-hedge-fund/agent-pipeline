## 1. Packaging source: reclassify `loop`

- [x] 1.1 In `scripts/build.mjs`, stop applying the shared fast-template orchNote to the `loop` operation (`fast: false` and/or dedicated `inRepoLoop` orchNote)
- [x] 1.2 Author the loop-specific orchestration note: long-running drive/resume, obtain `run_id` + events path, follow loop events, point to host SKILL for full protocol; keep `--audit` synchronous
- [x] 1.3 Run `node scripts/build.mjs` and confirm `plugin/pipeline/commands/pipeline:loop.md` no longer contains “completes in seconds” / “No background process or Monitor needed”

## 2. Host skill orchestration prose

- [x] 2.1 Add a loop orchestration section to `hosts/claude/SKILL.md` covering ordered steps: start/resume → handoff/`run_id`+events path → follow loop events → optional active-item advance events when published → stop on terminal/`loop_run_stopped`/process exit → summary/`--audit`
- [x] 2.2 List material must-notify kinds (`loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`, `loop_run_stopped`) and should-notify schedule/reconcile kinds with burst suppression
- [x] 2.3 Document interim follow path `<state-home>/runs/<run_id>/events.jsonl` with state-home resolution order; prefer future loop logs CLI when available without forbidding Monitor
- [x] 2.4 Mirror the same protocol (Codex-appropriate tooling names) in `hosts/codex/SKILL.md`
- [x] 2.5 Ensure true-fast modes in § “modes that don’t need orchestration” still exclude multi-item loop drive/resume (audit-only if listed as fast)

## 3. Drift-guard and regression coverage

- [x] 3.1 Extend `core/test/namespaced-commands.test.ts` (near existing loop wrapper 7.5b3) so rendered `loop` Claude command fails if seconds-only / no-Monitor phrases return
- [x] 3.2 Assert rendered `loop` content positively mentions long-running orchestration or event following
- [x] 3.3 Assert true-fast peers (`status`/`doctor`) may still use the shared fast template
- [x] 3.4 Prove the new guard bites: temporarily reintroduce the forbidden phrase and confirm the test fails, then restore the fix

## 4. Mirror, validate, CI

- [x] 4.1 Regenerate `plugin/` via `node scripts/build.mjs` so command + skill mirrors match sources
- [x] 4.2 Run `openspec validate loop-skill-event-orchestration` and fix structural issues if any remain
- [x] 4.3 Run `npm run ci` from repo root and fix failures until green
