## 1. Align train completion decode with resume-check

- [x] 1.1 Replace whole-stream `json.load` in the ship playbook post-train completion gate with stream scanning that decodes JSON via incremental `raw_decode` (or equivalent), skips non-JSON spans, and considers objects inside arrays
- [x] 1.2 Select the **last** decoded object with `kind == "train_status"` for `complete` / `blocker` evaluation
- [x] 1.3 Preserve success condition: complete only when selected status has `complete` true and no blocker
- [x] 1.4 Preserve blocker side-file write (`train.json.blocker` or current equivalent) when the selected status has a blocker
- [x] 1.5 Keep resume-path prior-complete detection behavior; avoid introducing a second incompatible parser shape

## 2. Regression coverage

- [x] 2.1 Fixture or pure-function test: prose + trailing complete `train_status` (no blocker) → gate success
- [x] 2.2 Fixture: pure JSON complete `train_status` → success (no pure-JSON regression)
- [x] 2.3 Fixture: last `train_status` incomplete → fail closed
- [x] 2.4 Fixture: last `train_status` with blocker → fail closed and blocker side file written
- [x] 2.5 Fixture: earlier incomplete + last complete → last wins / success
- [x] 2.6 Prove at least one happy-path mixed-stream case fails if the gate reverts to whole-stream `json.load` only

## 3. Scope and packaging

- [x] 3.1 Limit runtime edits to the supervisor ship playbook surface (`examples/supervisor/shell/pipeline-ship-playbook.sh` and any small helper extracted solely for testability)
- [x] 3.2 Do not change merge authority, advance/loop, or `pipeline train` stage semantics as part of this change
- [x] 3.3 If no `core/` runtime files change, skip `plugin/` mirror regen; if a helper is placed under `core/`, run `node scripts/build.mjs` and commit the mirror in the same commit

## 4. Verify

- [x] 4.1 `openspec validate ship-playbook-train-status-parse` passes
- [x] 4.2 Run the new/updated regression tests for the decode+evaluate logic
- [x] 4.3 Run the project gate required for touched surfaces (`npm run ci` if `core/` or CI-covered paths change; otherwise targeted tests + confirm playbook script change is the only product surface)
