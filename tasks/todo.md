# Scoped autonomous Hermes/Buzz factory

## Grok smoke configuration correction

- [x] Reproduce the live doctor failure from inherited `sonnet` intake and sweep treatments.
- [x] Configure all Grok implementer model slots as `grok-4.5`.
- [x] Extend the repository policy regression to cover all five Grok model slots.
- [x] Run focused tests and full repository CI.
- [ ] Merge and fast-forward the factory control checkout, then resume the existing grant.

## Bootstrap compatibility correction

- [x] Reproduce the live v1.33.0 grant startup failure without changing an issue or PR.
- [x] Read the external production pin without depending on the installed Pipeline JSON argument guard.
- [x] Keep pin promotion and rollback compatible with the pinned v1.31.1 CLI.
- [x] Add regressions for abbreviated pin identity and mutation command compatibility.
- [x] Run the factory tests and full repository CI.
- [ ] Deploy an exact, hashed correction and resume the admitted grant.

## Plan

- [x] Create a fresh task worktree from `origin/main`.
- [x] Read the shared contract, repository rules, selected skills, and living specs.
- [x] Capture live GitHub, `agent-box`, Buzz, Hermes, Pipeline, and FRG truth.
- [x] Create and validate the OpenSpec change for scoped factory authority.
- [x] Rewrite the factory plan and forward SemVer roadmap.
- [x] Correct the roadmap so every open issue has one representative SemVer milestone.
- [x] Update authority, release, self-hosting, and operator documentation.
- [x] Add the agent-box deployment assets, run contract, monitor, and rollback runbook.
- [x] Add tests and validation for all repository-owned behavior.
- [x] Replace caller-authored FRG receipts with the v1.33.0 live-plus-candidate-bound hybrid runner.
- [x] Prove two-release continuity: v1.33.0 installs itself, then the stable wrapper uses the v1.34.0 candidate-native release-preparation command without manual wrapper replacement.
- [x] Rebuild generated mirrors when `core/` changes.
- [x] Run `npm run ci` and all focused verification.
- [x] Commit, push, open PR #912, obtain review, and make CI green.
- [x] Apply and verify the corrected all-issue GitHub milestone migration.
- [ ] Deploy Hermes and Buzz access on `agent-box`.
- [ ] Verify the current v1.31.1 production pin, the v1.32.0 code base, and a live Grok 4.5/Codex smoke.
- [ ] Start the scoped v1.33.0 goal-loop for #905, #874, and #870.
- [ ] Merge each exact issue PR only after Pipeline reaches ready-to-deploy.
- [ ] Run full FRG, cut v1.33.0, verify publication, and install the new release.

## Review

- GitHub roadmap audit on 2026-08-08: 103 open issues, 103 milestone assignments, and zero unmilestoned issues.
- #908 and #909 moved to v1.34.0 so the native release-preparation seam lands before the factory needs to prepare its second release. The empty v1.33.1 milestone was closed.
- Repository verification on 2026-08-08: `npm run ci` passed, including the core suite, 118 factory tests, generated mirror checks, installer/launcher smoke tests, strict OpenSpec validation, docs checks, and script tests.
- Full CI exposed and verified a macOS `/var` versus `/private/var` recursion defect in the evaluation git shim. The fix canonicalizes PATH entries and has a symlink-path regression test.
- Final bounded implementation review found no P0 defects and one P1 defect: the shipped Hermes
  grant example omitted the required milestone. The example now includes the milestone, and a
  regression test parses and validates the actual shipped envelope. `npm run ci:ops` passes 119/119.
- Pull request #912 opened from commit `0c73aca0`; its required GitHub CI job passed in 2m38s.
- Live Buzz verification on 2026-08-08 proved the repeated three-minute messages were Hermes terminal wait timers, not Pipeline events. The deployed skill now starts the factory service with `systemctl --user start --no-block`, and the gateway was restarted to stop the old turn.
- Bootstrap correction verification on 2026-08-08: focused controller tests passed 28/28, `npm run ci:ops` passed 122/122, and full `npm run ci` passed.
