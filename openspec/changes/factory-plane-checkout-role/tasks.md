## 1. Checkout-role identity helper

- [ ] 1.1 Add a shared checkout-role factory-control predicate (live `REPO_DIR` / `AGENT_PIPELINE_FACTORY_CONTROL`, or a managed worktree of that root) in `core/scripts/production-engine-pin.ts` and verify hermetic tests pass when those signals match and fail when they are absent
- [ ] 1.2 Stop using GitHub owner/name (`config.repo === accidental-hedge-fund/agent-pipeline`) and `package.json` `repository` as factory-control identity; verify a test fails if that GitHub-name helper still returns factory-control for two-track defaults
- [ ] 1.3 Keep `resolveEngineTrackIntent` defaults: factory-control context → `pinned` for doctor/train/loop/single/advance; non-control → `null`; verify doctor/train on a non-control clone resolve to `null`

## 2. Doctor, train, and factory-pin callers

- [ ] 2.1 Wire doctor `install:engine-track` and `install:production-pin-path` to the checkout-role predicate; verify `install:engine-track` passes on a non-control clone with leftover `no-frg-1.39.1` and fails on the live control checkout with the same marker under pinned intent
- [ ] 2.2 Wire pipeline-run / train two-track default to the same predicate, including managed worktrees of the live control checkout; verify a developer-clone worktree stays inactive and a control-checkout worktree stays pinned
- [ ] 2.3 Wire `factory-pin` self-dogfood to checkout-role instead of `package.json` GitHub identity; verify `factory-pin` from a non-control clone without factory-control dir or pin-path override refuses before write
- [ ] 2.4 On the live control checkout with unset `AGENT_PIPELINE_PRODUCTION_PIN`, keep promote writing `$REPO_DIR/.agent-pipeline/production-engine-pin.json` only; verify no Hermes-state dual-write
- [ ] 2.5 Switch any other factory-plane caller of the GitHub-name helper (including factory-owned work-list admission) to checkout-role; verify GitHub owner/name no longer implies factory plane

## 3. Regression tests

- [ ] 3.1 Add a unit test that fails if `evaluateEngineTrackCheck` / doctor identity treats a non-control clone of `accidental-hedge-fund/agent-pipeline` as pinned and fails on `no-frg-1.39.1`
- [ ] 3.2 Add a unit test that fails if factory-control checkout context accepts a `no-frg-*` pin as production-quality
- [ ] 3.3 Prove `--skip-frg` still writes a non-production `no-frg-*` marker and that marker does not fail inactive clone doctor; tests inject I/O and perform no real network, git, or subprocess calls

## 4. Docs, mirror, gate

- [ ] 4.1 Align FRG runbook / supervisor identity wording so factory plane is the live control checkout, not GitHub owner/name, and host skill boot does not require `AGENT_PIPELINE_PRODUCTION_PIN`
- [ ] 4.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 4.3 Run `openspec validate factory-plane-checkout-role` and `npm run ci` from the repo root; fix failures until green
