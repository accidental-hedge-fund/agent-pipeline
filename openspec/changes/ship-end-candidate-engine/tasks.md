## 1. Shared identity helper

- [ ] 1.1 Add a pure helper that compares ship-end CLI identity (`--version` and/or source SHA) and playbook digest against the candidate SHA / candidate package version. Inject strings and file bodies. No network, git, or subprocess
- [ ] 1.2 Return fail when pin version/SHA ≠ candidate and the invoked CLI is the pin; fail when installed playbook digest ≠ candidate `examples/supervisor/shell/tugboat.sh` and the composer is not the repo script from `REPO_DIR`; skip when those tools are unused
- [ ] 1.3 Reuse `contentDigest` from `tugboat-install-parity.ts` (or a shared extract) so playbook vs candidate `tugboat.sh` uses the same digest as Option 1 pack parity

## 2. Tugboat and playbook compose

- [ ] 2.1 After train-complete, resolve the candidate engine (control checkout or managed worktree at the FRG-bound SHA, or an explicit candidate install). Do not reset operator `REPO_DIR` `HEAD` as the only path
- [ ] 2.2 Invoke `factory-release prepare`, `factory-gate`, `pipeline release`, `release finish`, and any composer-invoked tag through that candidate CLI. Keep train on process-start `$PIPELINE`
- [ ] 2.3 Fail closed before FRG pack when candidate identity cannot be resolved. Do not fall back to the previous production-pin `$PIPELINE` for those verbs
- [ ] 2.4 Mirror 2.1–2.3 in `pipeline-ship-playbook.sh` and shared helpers so the installed playbook cannot keep ship-end on the pin
- [ ] 2.5 Leave `engine-promote` on process-start `$PIPELINE`. Do not add `--skip-frg` as the default

## 3. In-engine ship coordinator

- [ ] 3.1 After train-complete, `pipeline ship` SHALL spawn or re-exec the candidate `core/scripts/pipeline.ts` for FRG pack, release, finish, and tag when the starting process is the previous production pin
- [ ] 3.2 Do not call in-process pin `runRelease` / prepare for those phases when pin identity ≠ candidate SHA. Train stays in the starting pin process

## 4. Tests

- [ ] 4.1 Regression: identity helper fails for CLI `--version` `1.39.4` vs candidate `1.39.5` / SHA `C`. Prove it would fail the 1.39.5 Tugboat fixture
- [ ] 4.2 Regression: identity helper fails when installed playbook digest `2afe3c92…` ≠ candidate `tugboat.sh` digest `9b8063d1…` and that playbook is used for ship-end
- [ ] 4.3 Source/composer check: Tugboat and playbook post-train FRG/release/finish invoke sites fail the test if they still use process-start `$PIPELINE` with no candidate rebinding
- [ ] 4.4 Ship-adapter test: post-train release/prepare is not invoked in-process from the pin when pin SHA ≠ candidate
- [ ] 4.5 Skip path: unused tools (no Tugboat, no playbook, no in-engine ship-end) skip rather than fail
- [ ] 4.6 Tests inject I/O or inspect source/fixtures. They start no live ship, network, git, or subprocess release

## 5. Doctor, docs, gate

- [ ] 5.1 Wire the identity helper into `pipeline doctor` (skip when unused; fail with remediation: refresh from candidate `tugboat.sh` or exec `$REPO_DIR/examples/supervisor/shell/tugboat.sh`, and invoke the candidate engine)
- [ ] 5.2 Update `docs/runbooks/ship-milestone.md` (and supervisor install notes if they still say every phase uses `$PIPELINE` / the production pin): train = pin; ship-end = candidate
- [ ] 5.3 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 5.4 Run `openspec validate ship-end-candidate-engine` and `npm run ci` from the repo root. Fix failures until green
