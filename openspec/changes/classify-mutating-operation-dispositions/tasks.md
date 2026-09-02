## 1. Command-form inventory

- [x] 1.1 Add a co-located TypeScript command-form inventory next to `command-registry.ts` (same rung as `command-docs.ts`) with `execution_disposition` and `authority_requirement` on every form, and verify a unit test round-trips those closed sets without importing the CLI
- [x] 1.2 Enumerate every `COMMAND_REGISTRY` key, numeric `advance`, nested subcommands, and documented `--dry-run` / `--apply` / `status` forms using the inspect-list table in `design.md`, and verify a missing mutating keyword fixture fails the contract test
- [x] 1.3 Document why durable lifecycle ownership does not apply on every `bounded-atomic-administration` row, and verify a row missing that reason fails the contract test
- [x] 1.4 Keep `OPERATION_SURFACE` as the host catalog, and verify a host-table-only verb without an inventory form fails the subset guard
- [x] 1.5 Cross-check parser dispatch keywords against inventory keywords, and verify a dispatch keyword with no form fails the agreement test

## 2. Supervised adapters

- [x] 2.1 Report `pipeline queue` nested-drive faults as RecoverySupervisor observations, and verify a nested throw/timeout fixture does not call `process.exit(1)` and does not leave that item ownerless
- [x] 2.2 Keep merge, train, ship, and recover-parked on their existing RecoverySupervisor adapter paths, and verify those forms are `supervised-lifecycle` (dry-run and `ship status` remain `read-only`)
- [x] 2.3 Adapt `release` prepare/finish and `factory-release` as supervised adapters, and verify a mechanical fault after admission stays owned
- [x] 2.4 Adapt `engine-promote` (non-dry-run) as a supervised adapter, and verify rollback remains `protected-authority` and dry-run remains `read-only`
- [x] 2.5 Adapt `grill` admit (non-dry-run, non-status) as a supervised adapter, and verify `grill --dry-run` and `grill status` write no recovery state

## 3. Typed-request resume

- [x] 3.1 Route `pipeline unblock` through the existing handoff resume-validation contract, and verify a unit test fails if unblock only clears `pipeline:blocked` and returns
- [x] 3.2 Route `pipeline override` auto-resume through the same resume-validation contract after the governed record is accepted, and verify a subsequent mechanical fault stays owned
- [x] 3.3 Keep `pipeline handoff answer` as the answer surface with no second ledger, and verify a stale-SHA fulfillment refuses resume
- [x] 3.4 Preserve kill-switch refusal on unblock and override, and verify no GitHub mutation occurs when the domain kill-switch file is present

## 4. Run-start preflight

- [x] 4.1 Convert `runStartPreflightGate` failure into a RecoverySupervisor observation or typed Capability Request without entering planning, and verify a failing-check fixture spends no implementer/reviewer tokens and leaves the drive owned
- [x] 4.2 Keep standalone `pipeline doctor` read-only with exit 1 on failed checks, and verify it writes no recovery episode, claim, Cooling record, or typed request
- [x] 4.3 Keep warn-level doctor results from blocking the drive, and verify a warn-only run-start still proceeds to planning

## 5. Bounded-atomic fences

- [x] 5.1 Skip unknown or unclassified worktree state in `sweepMergedWorktrees`, and verify an unclassified fixture is reported skipped and not removed
- [x] 5.2 Skip a fenced live owner (issue-run lock with live PID or live-planning marker) during cleanup even when the PR is merged, and verify the live run remains owned
- [x] 5.3 Refuse `remove-worktree` including `--force` when a fenced live owner holds the issue, and verify no `git worktree remove` or `git branch -D` is invoked
- [x] 5.4 Prove crash/failure of init, intake, triage, decompose `--apply`, sweep `--apply`, and roadmap `--apply` leaves no active run ownerless, and verify those forms stay `bounded-atomic-administration`

## 6. Static guards and read-only isolation

- [x] 6.1 Expand `collectCommandLocalLifecycleExits` beyond `scripts/stages` to supervised command modules, and verify a synthetic `process.exit(1)` on a mechanical fault fails the guard
- [x] 6.2 Remove supervised command-local `process.exit(1)` terminals only after the replacement observation exists, and verify parser exit 2 before mutation still works
- [x] 6.3 Guard read-only forms (`status`, `summary`, `logs`, standalone `doctor`, `ship status`, documented dry-run) against recovery writes, and verify a fixture that writes a recovery episode from a read-only form fails

## 7. Docs, packaging, and CI

- [x] 7.1 Align generated `docs/cli.md` and host SKILL usage with dry-run/apply/status dispositions, and verify an agreement test fails when generated text describes a read-only dry-run as a mutating drive
- [x] 7.2 After any `core/` edit run `node scripts/build.mjs` and verify `node scripts/build.mjs --check` passes
- [x] 7.3 Run `openspec validate classify-mutating-operation-dispositions` and `openspec validate --all`, and verify both exit 0
- [x] 7.4 Run `npm run ci` from the repo root, and verify the full gate passes
