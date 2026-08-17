## 1. Honest-pass checker

- [x] 1.1 Add a shared honest-pass helper next to `isReleaseEligibleFrgPass` that accepts only a post-1.33 `latest.json` (or equivalent evidence object) with `pass: true`, non-empty `run_id`, bound `loop_run_id`, `pack_id` `factory-gate-v1`, `pack_provenance.candidate_git_sha`, from-run provenance, and no observations-file authority
- [x] 1.2 Require required-live ids (`clean-item-throughput`, `blocker-taxonomy`, `empty-depends-on-stack-honesty`, OpenSpec-bearing composition) to be present and not `not_observed`
- [x] 1.3 Require every `source: layer_a` id to be on the closed Layer A-allowed set and to cite a TAP hash bound to the same candidate SHA
- [x] 1.4 Reject version `1.33.0` (or earlier), `pass: false`, product-milestone work-lists, and caller-authored observations as honest-pass evidence
- [x] 1.5 Call `isReleaseEligibleFrgPass` with `requireAttestation: false` so HMAC is not this issue's missing proof

## 2. Tests

- [x] 2.1 Checker accepts a fixture post-1.33 from-run pass with observed required-live and candidate-SHA TAP hashes. Prove the test fails without the helper
- [x] 2.2 Checker rejects `1.33.0` `pass: true` as the skip-frg restore precondition
- [x] 2.3 Checker rejects required-live `not_observed`, unknown `layer_a` ids, missing or other-commit TAP hashes, observations-file provenance, and a product-milestone work-list
- [x] 2.4 Checker rejects `pass: false` and does not treat a fail `latest.json` as unlock
- [x] 2.5 Tests inject I/O through deps. They make no real network, git, or subprocess calls

## 3. Candidate pack dogfood

- [ ] 3.1 Invoke `pipeline factory-release prepare --request <abs.json> --json` for a post-1.33 **candidate** version. Do not use the product v1.39 milestone work-list
- [ ] 3.2 Re-invoke the same request until the bound `loop_run_id` is terminal. Do not start a second unbound pack. Do not adopt an unbound newest `factory-gate` loop
- [ ] 3.3 Confirm the terminal score used `factory-gate --for <ver> --from-run <id>` (or the in-process equivalent) and did not pass `--observations`
- [x] 3.4 Persist `.agent-pipeline/frg/<ver>/latest.json` only when the honest-pass checker accepts it. A fail score stays `pass: false`

## 4. Evidence citation and no-waive

- [ ] 4.1 If the checker accepts the artifact, comment on issue #1038 with the evidence path and `frg_run_id`
- [x] 4.2 If the pack cannot pass honestly, leave #1038 open. Do not start #1039. Do not rewrite fail to `pass: true`

## 5. Docs, Tugboat keep-skip, packaging

- [x] 5.1 Update `docs/factory-reliability-gate-runbook.md` so the Tugboat / release `--skip-frg` default stays until the honest-pass checker accepts one post-1.33 from-run artifact
- [x] 5.2 Confirm Tugboat default release and promote argv still include `--skip-frg`. Do not add an FRG pack phase in this change
- [x] 5.3 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 5.4 Run `openspec validate frg-honest-post-133-candidate-pass` and `npm run ci` from the repo root. Fix failures until green
