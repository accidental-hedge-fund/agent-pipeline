## 1. Protocol surface

- [x] 1.1 Add public JSON `status: "in_progress"` (bound `loop_run_id` + restart checkpoint) to `factory-release prepare` result types. Keep `awaiting_frg_attestation`, `complete`, and `failed`
- [x] 1.2 Stop treating a missing pre-bound loop as terminal `missing_generator` / `pack_loop_missing` on a post-1.33 request. That case SHALL start or resume the bound pack loop
- [x] 1.3 Update `FACTORY_RELEASE_PREPARE_HELP` so the first tick is start/resume, not “bind a loop yourself”

## 2. Pack issues and bound loop dispatch

- [x] 2.1 Implement the production `startBoundPackLoop` default: create or reuse `factory-gate` issues from `frg-packs/factory-gate-v1/templates/` via `renderFrgPackIssues`, meeting the manifest minimum item count
- [x] 2.2 Dispatch `pipeline loop --engine-track candidate` with the pack work-list or `--label factory-gate`. Inject the dispatch through a testable seam (no real subprocess in unit tests)
- [x] 2.3 Write `factory-release-binding.json` on the started run (request fingerprint, candidate SHA, version, manifest) and persist `loop_run_id` on `pack-instance.json`
- [x] 2.4 Re-invoke with the same request resumes that `loop_run_id`. Do not start a second unbound pack. Do not adopt the newest unbound `factory-gate` loop

## 3. Terminal scoring and latest.json

- [x] 3.1 When the bound loop is terminal, score through `runFactoryGate` / `factory-gate --for <ver> --from-run <id>`. Do not pass `--observations` or a work-directory observations file
- [x] 3.2 Apply hybrid v2 from #1036 (required-live from the candidate pack loop; Layer A TAP hashes on the same candidate SHA). Do not invent `pass: true`
- [x] 3.3 Write release-eligible `.agent-pipeline/frg/<ver>/latest.json` with `pass: true` only when `isReleaseEligibleFrgPass` is true. Fail stays `pass: false` and does not unlock `status: "complete"`
- [x] 3.4 After unsigned artifacts exist, keep the existing attestation → `runRelease` ticks. Prepare still never merges, tags, promotes a pin, or sets `--skip-frg`

## 4. Tests

- [x] 4.1 First prepare with no pre-existing loop dispatches the injected start seam, persists `loop_run_id`, and returns `status: "in_progress"`. Prove the test fails without the production change
- [x] 4.2 Second call with the same request resumes the same `loop_run_id` and does not call start again
- [x] 4.3 Unbound newest `factory-gate` loop is not adopted
- [x] 4.4 Terminal score path invokes `--from-run` and does not pass `--observations`. Fail score does not write `pass: true` `latest.json`
- [x] 4.5 Tests inject I/O through deps. They make no real network, git, or subprocess calls
- [x] 4.6 Crash after persist before spawn: re-invoke resumes the same `loop_run_id` and does not start a second pack
- [x] 4.7 Detached spawn startup failure (ENOENT): first tick fails; re-invoke retries the same bound run

## 5. Docs and packaging

- [x] 5.1 Update `docs/factory-reliability-gate-runbook.md` so post-1.33 `factory-release prepare` starts/resumes the bound pack loop and scores with `--from-run` (no `--observations`)
- [x] 5.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 5.3 Run `openspec validate factory-release-prepare-bound-pack-loop` and `npm run ci` from the repo root. Fix failures until green
