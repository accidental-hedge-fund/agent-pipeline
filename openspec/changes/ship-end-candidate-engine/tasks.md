## 1. Shared identity helper

- [ ] 1.1 Add a pure helper that compares ship-end engine `commit_sha` (exact 40-hex) and playbook composer kind against the candidate SHA. Inject strings, digests, and SHA. No network, git, or subprocess
- [ ] 1.2 Return fail when invoked `commit_sha` ≠ candidate SHA (including null) while ship-end tools are in use; fail when a selected playbook is not a thin launcher to `$REPO_DIR/examples/supervisor/shell/tugboat.sh`; skip when those tools are unused. Matching package version with mismatched SHA SHALL fail
- [ ] 1.3 Reuse `contentDigest` from `tugboat-install-parity.ts` (or a shared extract) so resolved `tugboat.sh` vs candidate `tugboat.sh` uses the same digest as Option 1 pack parity
- [ ] 1.4 Expose `pipeline --version --json` as `{ version, commit_sha }` via `resolveEngineCommitSha` (null when unresolvable; never invent). Keep human `--version` as package version

## 2. Tugboat compose and candidate resolution

- [ ] 2.1 After train-complete, resolve the candidate engine using the closed contract (SHA from request JSON; allowlist: clean `REPO_DIR` HEAD, `.worktrees/ship-candidate-<sha>`, or `PIPELINE_CANDIDATE_ENGINE_ROOT`). Do not reset operator `REPO_DIR` HEAD as the only path. Treat SHA and paths as data, not shell fragments
- [ ] 2.2 Invoke `factory-release prepare`, `factory-gate`, `pipeline release`, and `release finish` through `SHIP_END_CLI` (`node "$ENGINE_ROOT/scripts/pipeline-launcher.mjs"`). Keep train and `engine-promote` on process-start `$PIPELINE`. Tugboat SHALL NOT invoke `git tag` / `gh release create`
- [ ] 2.3 Fail closed before FRG pack when candidate identity cannot be resolved. Do not fall back to the previous production-pin `$PIPELINE` for those verbs. Leave train checkpoint in place for retry
- [ ] 2.4 Preserve #1133 isolation: uncredentialed prepare child vs separately credentialed `factory-gate` child. Candidate resolution MUST NOT leak FRG credentials into prepare env, request JSON, or recorded paths
- [ ] 2.5 Leave `engine-promote` on process-start `$PIPELINE`. Do not add `--skip-frg` as the default

## 3. Playbook launcher

- [ ] 3.1 Replace `examples/supervisor/shell/pipeline-ship-playbook.sh` with a thin launcher that execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh`. Document install of that launcher to `~/.local/bin/pipeline-ship-playbook`
- [ ] 3.2 Doctor/identity helper fails a selected stale full playbook (including digest `2afe3c92…`) and names refresh-to-launcher or exec of repo `tugboat.sh`

## 4. In-engine ship coordinator

- [ ] 4.1 After train-complete, `pipeline ship` SHALL spawn candidate leaf verbs for FRG pack, `factory-gate`, `release`, `release finish`, and `ensureAnnotatedReleaseTag` when the starting process SHA ≠ candidate SHA. Do not re-exec `pipeline ship`. Do not rerun train. Recursion is impossible because argv is never `ship --milestone`
- [ ] 4.2 Do not call in-process pin `runRelease` / prepare / `ensureAnnotatedReleaseTag` when pin SHA ≠ candidate. Persist resolution failure before any FRG/release mutation. Promote stays in-process pin

## 5. Tests

- [ ] 5.1 Regression: identity helper fails for CLI `commit_sha` of pin `1.39.4` vs candidate SHA `C` even when `--version` is forged equal to the candidate package version
- [ ] 5.2 Regression: identity helper fails when installed playbook is a stale full compose (digest `2afe3c92…`) and that playbook is selected for ship-end
- [ ] 5.3 Source/composer check: Tugboat post-train FRG/release/finish invoke sites fail the test if they still use process-start `$PIPELINE` with no `SHIP_END_CLI` rebinding. Playbook source is a launcher (exec repo `tugboat.sh`)
- [ ] 5.4 Ship-adapter test: post-train release/prepare/tag is not invoked in-process from the pin when pin SHA ≠ candidate; spawn argv uses the candidate launcher. Handoff failure leaves train evidence and does not start FRG
- [ ] 5.5 Skip path: unused tools (no Tugboat, no playbook, no in-engine ship-end) skip rather than fail
- [ ] 5.6 Repo-script launcher passes; candidate unavailable fails closed; prepare spawn has KEY unset while attestor spawn is separate
- [ ] 5.7 Required fixture: production pin CLI `1.39.4` cannot execute the candidate `release.ts` fix; resolved candidate CLI can. Composer after train-complete records candidate argv, not pin argv (PATH stub / injected spawn, same family as `writeFakePipeline` in `tugboat.test.ts`)
- [ ] 5.8 Tests inject I/O or inspect source/fixtures. They start no live ship, network, git, or subprocess release. Shell tests may spawn bash + a PATH stub of `pipeline` as existing Tugboat tests already do; they SHALL NOT call a real engine or GitHub

## 6. Doctor, docs, gate

- [ ] 6.1 Wire the identity helper into `pipeline doctor` (skip when unused; fail stale selected playbook only when selected; bound SHA check when a request/ship status carries the candidate SHA; remediation names candidate engine + launcher/repo `tugboat.sh`)
- [ ] 6.2 Update `docs/runbooks/ship-milestone.md` (and supervisor install notes if they still say every phase uses `$PIPELINE` / the production pin): train + promote = pin; ship-end = candidate; playbook is a launcher
- [ ] 6.3 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 6.4 Run `openspec validate ship-end-candidate-engine` and `npm run ci` from the repo root. Fix failures until green. Do not claim suite pass without current SHA-pinned tester evidence
