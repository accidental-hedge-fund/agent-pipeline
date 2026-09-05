## Why

During the v1.40.1 factory-release pack, issue #1457 reached the test gate under a candidate ship child. `runTests` spawned the repo test command (`npm run ci`) with the parent process environment, so the child inherited factory topology (`AGENT_PIPELINE_FACTORY_CONTROL`, `AGENT_PIPELINE_PRODUCTION_PIN`, `REPO_DIR`, `PIPELINE_CANDIDATE_ENGINE_ROOT`, `PIPELINE_PACK_LOOP_CANDIDATE_SHA`, `PIPELINE_STARTING_LOCK_PID`), every current `PIPELINE_CANDIDATE_PROCESS_*` guard/lease variable, and operator merge authority (`ALLOW_MERGE`). Launcher and readiness tests then resolved temporary fixtures through the live ship topology and failed. The same inheritance also exposes merge authority to a repo-controlled command.

This is a class defect, not a #1457-only mole: any repo-controlled test-gate spawn under a candidate ship process can read factory control, pin paths, candidate-process lease data, and `ALLOW_MERGE`. The next identical fault must not require a new site issue.

## What Changes

- `runTests` SHALL spawn the repo test/build command in an environment that keeps ordinary build inputs (`PATH`, `HOME`, `NODE_*`, `npm_*`, CI tokens unrelated to factory topology) and removes factory topology, candidate-process lease/guard data, pack-loop candidate SHA, starting-lock pid, and merge authority.
- The isolated name set SHALL be derived from existing single-sourced constants where they already exist (`CANDIDATE_PROCESS_GUARD_ENV`, `FACTORY_CONTROL_DIR_ENV`, `PRODUCTION_PIN_ENV`, `FACTORY_PLANE_REPO_DIR_ENV`, `PIPELINE_PACK_LOOP_CANDIDATE_SHA_ENV`) plus the remaining named literals in this issue (`PIPELINE_CANDIDATE_ENGINE_ROOT`, `PIPELINE_STARTING_LOCK_PID`, `ALLOW_MERGE`). A new guard field on `CANDIDATE_PROCESS_GUARD_ENV` SHALL be stripped without a new mole issue.
- Isolation applies only at the repo test-command spawn inside `runTests`. The pipeline controller process and harness (`invoke` / implement / review / fix) environment SHALL stay unchanged.
- Timeout, process-group kill, capture, and pass/fail semantics of the test gate SHALL stay unchanged.
- An injectable spawn regression test SHALL prove the isolated names are absent from the child env and that an unrelated sentinel variable is preserved.

## Capabilities

### New Capabilities

- None. Isolation is a spawn-environment rule on the existing test/build gate, not a new product surface.

### Modified Capabilities

- `test-build-gate`: `runTests` SHALL strip factory topology, candidate-process guard/lease variables, pack-loop candidate SHA, starting-lock pid, and `ALLOW_MERGE` from the spawned repo test process while preserving ordinary build inputs. Harness and controller env SHALL NOT be rewritten. Timeout, process-group, and capture behavior SHALL stay as specified today.

## Impact

- `core/scripts/testgate.ts` — `runTests` builds the child env overlay and passes it through the existing `runCapped` spawn path.
- `core/scripts/harness.ts` — `runCapped` may omit `undefined` env keys after the existing `{ ...process.env, ...opts.env }` merge so stripped names are absent at spawn. When `opts.env` is absent, spawn still carries no `env` key (harness default path unchanged).
- `core/test/testgate.test.ts` — injectable `spawnFn` regression that the isolated names are absent and an unrelated variable is preserved; existing timeout / process-group / capture tests stay green.
- Reuse, not a new layer: copy-and-delete overlay through existing `runCapped` `opts.env` + `#384` `spawnFn`. Do not reuse `sanitizeCandidateLoopEnv` (that denylist is FRG signing credentials). Do not add a config key, a new isolation module, or harness env rewriting.
- After `core/` edits: `node scripts/build.mjs`. Full gate: `npm run ci`.

## Acceptance criteria

- [ ] `runTests` removes all current `CANDIDATE_PROCESS_GUARD_ENV` names, `AGENT_PIPELINE_FACTORY_CONTROL`, `AGENT_PIPELINE_PRODUCTION_PIN`, `REPO_DIR`, `PIPELINE_CANDIDATE_ENGINE_ROOT`, `PIPELINE_PACK_LOOP_CANDIDATE_SHA`, `PIPELINE_STARTING_LOCK_PID`, and `ALLOW_MERGE` from the spawned repo test process.
- [ ] An injectable spawn regression test proves those names are absent on the spawn `env` object (not present as string values) and that a normal unrelated environment variable is preserved.
- [ ] A drift-guard assertion fails if `CANDIDATE_PROCESS_GUARD_ENV` gains a name that the test-gate strip list does not include.
- [ ] Existing test-gate timeout, process-group kill, and capture behavior is unchanged (existing tests stay green).
- [ ] Harness `invoke` / `runCapped` callers that omit `opts.env` still spawn with no `env` key; papercut identity overlay still merges additively.
- [ ] The v1.40.1 clean OpenSpec FRG case can run `npm run ci` while its parent is a candidate ship process (launcher/readiness tests do not resolve fixtures through live factory topology).
- [ ] `node scripts/build.mjs` and `npm run ci` pass.
