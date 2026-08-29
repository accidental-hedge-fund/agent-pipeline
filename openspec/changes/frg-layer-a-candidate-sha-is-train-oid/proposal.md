## Why

v1.39.15 ship-spawned `factory-gate --from-run` HMAC `latest.json` stamped `pack_provenance.candidate_git_sha=a884d1ed…` (production pin 1.39.14). The factory-release request packed candidate was train head `6670cee…`. Control checkout `REPO_DIR` HEAD was six commits behind `origin/main`. Hybrid-v2 collect uses `git rev-parse HEAD` in `repoDir`. `release ensure-tag` then throws `HMAC candidate_git_sha is not this ship's packed candidate`. Issue #1151 already runs FRG on the candidate engine launcher. Provenance still records control HEAD.

This is a **class** defect: from-run collect binds Layer A / pack provenance to the control checkout HEAD instead of the request packed candidate. The v1.39.15 attest loop is one site. Fast-forwarding the operator control checkout is not the product fix. Skipping HMAC is not the product fix.

## What Changes

- **Class law:** hybrid-v2 / Layer A `candidate_git_sha` SHALL equal factory-release request `integrated_candidate.git_sha` (train packed candidate), not `git rev-parse HEAD` of the control checkout, when those differ.
- **Probe records:** every Layer A probe record SHALL use that same packed-candidate OID as `pack_provenance.candidate_git_sha`. Probes SHALL execute against candidate engine sources for that OID.
- **ensure-tag:** packed candidate `C` SHALL accept HMAC evidence bound to `C` when the score ran on candidate engine sources for `C`. The helper SHALL NOT throw `HMAC candidate_git_sha is not this ship's packed candidate` because control HEAD is pin `P`.
- **Regression:** a unit test SHALL fail when `repoDir` HEAD is pin `P`, the request candidate is `C`, and collected provenance stamps `P`.
- **Does not:** fast-forward the operator control checkout as the fix; skip HMAC; loosen ensure-tag to accept pin SHA `P` as packed candidate `C`; merge inside advance/loop; restore `--skip-frg`.

## Acceptance criteria

- [ ] When `REPO_DIR` HEAD is pin `P` and the factory-release request `integrated_candidate.git_sha` is train candidate `C` (`P ≠ C`), `factory-gate --from-run` hybrid-v2 collect writes `pack_provenance.candidate_git_sha` equal to `C`, not `P`.
- [ ] Every Layer A probe record on that evidence uses the same OID as `pack_provenance.candidate_git_sha` (`C`).
- [ ] Layer A probes for that score execute against candidate engine sources for `C`. They do not treat control-checkout HEAD `P` as the candidate identity.
- [ ] `release ensure-tag X.Y.Z <merge> --packed-candidate C` accepts HMAC `latest.json` whose bound `candidate_git_sha` is `C` when that score ran on candidate engine sources for `C`. It does not throw `HMAC candidate_git_sha is not this ship's packed candidate` because control HEAD is `P`.
- [ ] `release ensure-tag` still fail-closes when HMAC `candidate_git_sha` is pin `P` and packed candidate is `C`. HMAC is not skipped. Control checkout is not required to fast-forward to `C` as the product fix.
- [ ] A unit test fails if `repoDir` HEAD is `P`, the request candidate is `C`, and collected provenance stamps `P`. Tests inject I/O. They do not use real network, git, or subprocess.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This binds existing hybrid-v2 collect identity to the request packed candidate. -->

### Modified Capabilities

- `factory-reliability-gate`: From-run hybrid-v2 collect SHALL stamp `pack_provenance.candidate_git_sha` and Layer A probe `candidate_git_sha` from one resolver: loop `factory-release-binding.json` `candidate_git_sha` and, when in hand, request `integrated_candidate.git_sha`. Both SHALL agree after exact-40-hex normalize. Collect SHALL NOT use control-checkout `git rev-parse HEAD` on that ship-path. Probes SHALL run with cwd from `resolveCandidateEngine` at that OID.
- `ship-on-disk-frg-tag`: `release ensure-tag` SHALL accept HMAC evidence whose bound candidate SHA equals this ship's packed candidate `C` when control HEAD is a different pin `P`. It SHALL still fail closed when HMAC binds `P` instead of `C`.

## Impact

- `core/scripts/frg-hybrid-v2-from-run.ts` — `defaultCollectHybridV2FromRun` / `defaultGitHead(repoDir)` is the live mole. Collect must resolve packed candidate `C` from loop binding and (when in hand) request `integrated_candidate.git_sha`, never from control HEAD on ship-path. Probe cwd must be `resolveCandidateEngine` at `C`.
- `core/scripts/factory-reliability-gate.ts` — `--from-run` collect seam; persist HMAC `latest.json` with packed candidate `C`.
- `core/scripts/factory-release-prepare.ts` — loop `factory-release-binding.json` already records `candidate_git_sha`; `defaultScoreBoundPackLoop` SHALL pass request `integrated_candidate.git_sha` into collect so both sources can agree.
- `core/scripts/ship-end-candidate.ts` — reuse `resolveCandidateEngine` for Layer A TAP cwd. Do not reset operator `REPO_DIR`.
- `core/scripts/stages/ship-adapter.ts` — `hmacPackedCandidateGitShaFromUnknown` vs `--packed-candidate` stays fail-closed on mismatch. No HMAC skip. No rewrite of `latest.json` to the merge commit. No comparison-helper change.
- Tests: `core/test/frg-hybrid-v2-from-run.test.ts` (primary bite: HEAD=`P`, request/binding=`C`, stamps `C`, `gitHead(repoDir)` not consulted, probe cwd is candidate engine for `C`); missing/malformed/conflict fail closed; standalone HEAD retained; ensure-tag packed-candidate cases stay fail-closed when HMAC is `P`. Inject I/O.
- Generated `plugin/` mirror after any `core/` edit.
- Docs: FRG runbook may name request candidate vs control HEAD. No `--skip-frg` restore. No `auto_merge`.
