# #1151 Revised plan — ship-end runs the candidate engine

## Status

- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [ ] Implementation
- [ ] Tests (PATH-stub / injected spawn first; prove they fail on current compose)
- [ ] Docs + OpenSpec task/design precision
- [ ] `node scripts/build.mjs` after any `core/` edit
- [ ] `npm run ci`

## Locked decisions (post plan-review)

1. Candidate SHA is the 40-hex `integrated_candidate.git_sha` (Tugboat request JSON) or `ShipTrainEvidence.integrated_head_oid` (in-engine ship). Not cwd HEAD. Not version.
2. Allowed roots: clean `REPO_DIR` HEAD==SHA, `$REPO_DIR/.worktrees/ship-candidate-<sha>`, or `PIPELINE_CANDIDATE_ENGINE_ROOT`. Entrypoint: `node "$ENGINE_ROOT/scripts/pipeline-launcher.mjs"`. CWD: `REPO_DIR`.
3. Identity: exact source SHA. `--version --json` emits `{ version, commit_sha }`. Version match with SHA mismatch fails.
4. Installed playbook is a thin launcher to repo `tugboat.sh`. No second compose.
5. In-engine ship: pin process stays coordinator; spawn leaf candidate verbs. Do not re-exec `pipeline ship`. Do not rerun train. Fail before FRG/release mutation if resolution fails.
6. Tugboat does not tag. In-engine tag is `ensureAnnotatedReleaseTag` on the candidate. Promote stays on the pin.
7. Keep #1133 credential split. SHA and paths are data, not shell fragments.

See `openspec/changes/ship-end-candidate-engine/design.md` for the full contract.
