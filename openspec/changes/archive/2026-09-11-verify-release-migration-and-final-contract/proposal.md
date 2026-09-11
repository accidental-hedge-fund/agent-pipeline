## Why

Packages 1–3 already own no-change Tester proof, exact-candidate FRG, and independently complete `pipeline release`. Operators still see mixed live and historical instructions across the CLI catalog, host shims, ordinary docs, and living specs, and stale failed-ship ledgers can look like a prerequisite. This package 5 of 5 makes one coherent product contract and ownership-safe migration of known failed synthetic artifacts. It does not run the live `v1.40.1` publication.

## What Changes

- Present independent `pipeline release` as **direct-release**: the complete SemVer contract for an exact candidate. Present ship's final completion as **ship-final-delegation** to that same release. Neither path deploys, promotes, or installs.
- Align generated host shims, ordinary docs, and living specs with that same live contract.
- Keep historical optional-FRG, `release finish`, and ship-promotion instructions identifiable as historical. They are not the live procedure.
- Treat **historical-failed-ship-evidence** (old failed-ship ledgers, scorer files, and attestor files) as superseded. A new release does not require a working old scorer or attestor. A historical pass is not current-candidate authority.
- Add ownership-safe cleanup and migration behavior for known failed synthetic artifacts. Tests use injected I/O or isolated real Git fixtures. Tests do not close unrelated issues or pull requests, delete user worktrees, or treat simulated cleanup as proof of operator cleanup.
- Keep command-interface regression coverage for every approved case on the live contract.
- Record an operator post-merge live checklist. Every item stays unchecked until the observation occurs after merge.
- Report required alignment when protected `CLAUDE.md`, rules, settings, or commands disagree. This change does not edit those protected files.
- Do not start the real release, create live FRG issues, create a tag, publish, install, promote, or deploy. Do not hand-edit ledgers, delete diagnostic evidence to reset budgets, add a second scheduler, add a temporary Sol override, or add a synthetic fixture implementation.

## Acceptance Criteria

- [ ] `OPERATION_SURFACE` and the four generated host SKILLs present independent `pipeline release` as direct-release and `pipeline ship --milestone` final completion as ship-final-delegation.
- [ ] Generated `docs/cli.md` and ordinary operator docs present that same live contract. Historical optional-FRG, `release finish`, and ship-promotion text is labeled historical and is not the live procedure.
- [ ] Living specs present the same live contract. `ship-coordinator` no longer requires factory-pack FRG, `release finish`, engine-promote, or install as the live ship tail.
- [ ] A committed report lists protected `CLAUDE.md`, rules, settings, and commands that disagree with the live contract, or states that they already agree. This change does not edit those files.
- [ ] Direct-release and ship-final-delegation complete the same SemVer contract for an exact candidate. Neither path deploys, promotes, or installs. Injected-I/O tests prove that equivalence.
- [ ] Old failed-ship ledgers, scorer files, and attestor files remain as historical-failed-ship-evidence. A new release of the current candidate succeeds without a working old scorer or attestor. A historical pass is not accepted as current-candidate authority.
- [ ] Command-interface regression coverage exists for every approved case: milestone integration checks; isolated metadata-first merge; candidate source identity; exactly two issues across partial create and resume; same-host duplicate exclusion; fresh genuine `pipeline:ready-to-deploy`; rejection of false, forged, wrong-head, and mismatched evidence; no fixture merging; correct external-wait versus regression handling; unchanged and changed Tester candidates; dirty pre-commit CI; stale main; tag and publication idempotency; cleanup debt; equivalent direct-release and ship-final-delegation without deployment.
- [ ] Ownership-safe cleanup and migration of known failed synthetic artifacts is proven with injected I/O or isolated real Git fixtures. Tests do not close unrelated issues or pull requests, delete user worktrees, or treat simulated cleanup as proof of operator cleanup.
- [ ] Optional observability from #1482 remains. Permanent repository models and review policy remain. The product pull request does not add a temporary Sol override, a synthetic fixture implementation, or a second scheduler.
- [ ] This change does not edit ledgers by hand and does not delete diagnostic evidence to reset budgets.
- [ ] `npm run ci` passes. Generated build and docs checks pass. This work does not start the real release, create live FRG issues, create a tag, publish, install, promote, or deploy.
- [ ] An operator checklist records: test exact main `C`; obtain two unmerged `pipeline:ready-to-deploy` results; create annotated `v1.40.1` at `C`; verify matching versions and notes and a non-draft publication; prove a repeated release of that publication is idempotent. Every item stays unchecked in this issue.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `release-simplification-contract`: Identify this change as package 5 of 5. Record the live direct-release and ship-final-delegation contract, historical-procedure labeling, historical-failed-ship-evidence authority, the approved command-interface regression set, protected-file alignment reporting, policy-stability constraints, and the unchecked operator post-merge checklist.
- `ship-coordinator`: Replace the live post-train tail with exactly one complete-release delegation. Mark factory-pack FRG, `release finish`, ship-promotion, and install as historical. Neither live path deploys, promotes, or installs.
- `exact-candidate-frg`: Treat old scorer, attestor, and failed-ship artifacts as historical-failed-ship-evidence. Add ownership-safe cleanup and migration of known failed synthetic artifacts without closing unrelated issues or pull requests, deleting user worktrees, hand-editing ledgers, or deleting diagnostic evidence to reset budgets.
- `generated-cli-reference`: Present independent `release` as direct-release and ship completion as ship-final-delegation in the generated CLI catalog. Do not present historical optional-FRG, finish, or ship-promotion as the live command contract.
- `generated-short-host-skill`: Present the same live release and ship contract in the four generated host SKILL verb tables.

## Impact

Catalog text in `core/scripts/operation-surface.ts` feeds `docs/cli.md` and the four host SKILLs through the existing generators. Living `ship-coordinator` requirements currently still describe factory-pack FRG, `release finish`, engine-promote, and install as live ship phases and must change. Ordinary operator docs (`docs/runbooks/ship-milestone.md`, `docs/supervisor.md`, and related FRG runbooks) still mix live and historical procedure. Command-interface tests already exist under `core/test/release-complete.test.ts`, `core/test/exact-candidate-frg.test.ts`, and `core/test/ship-adapter.test.ts`; this package fills remaining approved-case gaps and adds ownership-safe migration tests on those same seams.

This change depends on #1560 (package 4 retirement of remaining obsolete callers). It does not implement package 4. It does not invoke live release. Protected `CLAUDE.md`, rules, settings, and commands stay unedited.
