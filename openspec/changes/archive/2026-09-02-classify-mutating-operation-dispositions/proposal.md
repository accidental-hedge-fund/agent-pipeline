## Why

Issue advancement is migrating onto RecoverySupervisor, but less-visible mutating commands can still bypass that owner. Command-local catches, raw `process.exit(1)`, and direct state writes can end a lifecycle-affecting mutation without durable ownership, a typed request, or authenticated cancellation.

## What Changes

- Add one executable command-form inventory that covers `COMMAND_REGISTRY`, default numeric invocation, nested subcommands, and mode-dependent forms (`--dry-run`, `--apply`, `status`, and peers).
- Classify every form on two independent axes: execution disposition (`read-only`, `bounded-atomic-administration`, `supervised-lifecycle`) and authority requirement (`none`, `typed-response`, `protected-authority`).
- Keep `OPERATION_SURFACE` as the host and documentation catalog. It is not the complete inventory.
- Adapt every `supervised-lifecycle` form into RecoverySupervisor as an operation adapter. Mechanical failure and retry exhaustion do not end ownership.
- Stop lifecycle-affecting forms from terminating through raw `process.exit(1)` on mechanical faults. Parser usage errors (exit 2) stay parser-level.
- Convert failed run-start preflight (`doctor.runOnStart` or `--doctor` on a drive) into a recoverable observation or a typed Capability Request. Standalone `pipeline doctor` stays a read-only diagnostic.
- Route `unblock`, `override`, and handoff answers through the existing typed-request resume contract. Do not add a second answer ledger.
- Require every bounded-atomic form to finish in one bounded transaction, leave no active ownership, and be idempotent or fully reconcilable. Document why durable lifecycle ownership does not apply. Prove that failure leaves no active run ownerless.
- Make cleanup preserve unknown state and refuse a fenced live owner. Make `remove-worktree` refuse a fenced live owner.
- Forbid read-only forms from mutating recovery state.
- Drift-guard registry, parser, generated docs, and executable behavior so they agree. A new mutating verb without a disposition fails the suite.

## Capabilities

### New Capabilities

- `operation-inventory`: executable command-form disposition inventory; two independent classifications; RecoverySupervisor adaptation for supervised forms; bounded-atomic ownership proof; read-only recovery isolation; contract tests that fail on a missing mutating disposition.

### Modified Capabilities

- `command-registry`: every registry keyword, numeric drive, nested subcommand, and documented mode form has a disposition. `mutatesGitHub` is not a substitute for execution disposition.
- `generated-cli-reference`: generated CLI docs and host SKILL tables agree with the inventory. `OPERATION_SURFACE` remains the host catalog, not the complete inventory.
- `doctor-preflight`: failed run-start preflight is a recoverable observation or typed Capability Request. Standalone doctor may still exit 1.
- `human-question-handoff`: `unblock`, `override`, and answers resume through the typed-request resume contract.
- `governed-overrides`: override recording still uses governed authority, then resumes through that same typed-request contract rather than a command-local re-entry that can terminalize the run.
- `worktree-stale-cleanup`: cleanup preserves unknown state and cannot interfere with a fenced live owner.
- `worktree-per-run-removal`: `remove-worktree` cannot interfere with a fenced live owner.
- `batch-queue-engine`: `pipeline queue` is a supervised-lifecycle form. It does not silently terminate nested drives through raw exit.

## Impact

- **Class vs site:** command-local catches, raw `process.exit(1)`, and missing dispositions on mutating forms are one class: lifecycle-affecting mutations that bypass RecoverySupervisor. The class fix is the executable inventory, adapter reporting, typed-request resume, and static lifecycle-exit guards. A mole on one verb (for example only `queue` or only run-start doctor) is incomplete.
- **Reuse first:** extend `COMMAND_REGISTRY` plus a co-located form inventory, matching `command-docs.ts`. Reuse the inventory-plus-drift-guard pattern in `ship-path-composition-coverage.ts` and `fault-recovery-matrix.ts`. Reuse RecoverySupervisor observation types already named in `CONTEXT.md` and used by `merge-supervision.ts` / `ship-supervision.ts`. Reuse `pipeline handoff answer` resume validation. Reuse `collectCommandLocalLifecycleExits` in `fault-recovery-static-guards.ts`. Do not add a second command-grammar module, RecoverySupervisor, answer ledger, or public inventory CLI verb.
- **CLI:** no new public verb. Existing keywords keep their grammar. Dry-run, apply, and status remain mode forms of those keywords.
- **Tests:** hermetic unit tests inject gh/harness/worktree fakes. Contract tests fail when a `COMMAND_REGISTRY` key or documented mode form has no disposition, when a supervised form uses lifecycle `process.exit(1)`, when cleanup removes unknown or live-owned state, and when a read-only form writes recovery state. No real network, git, or subprocess in unit tests.
- **Docs:** `CONTEXT.md` already defines Operation disposition. Align `docs/cli.md`, host SKILLs, and living specs. Run `node scripts/build.mjs` after `core/` edits.
- **Sequencing:** consumes RecoverySupervisor (#1323) as sole lifecycle owner and follows issue-advancement migration (#1328). Does not reimplement ship-phase supervision (#1331), liveness (#1332), or the fault matrix (#1333). #1333 consumes this inventory as the operation dimension.

## Acceptance Criteria

- [ ] One executable inventory classifies every `COMMAND_REGISTRY` keyword, default numeric invocation, nested subcommand, and documented mode form (`--dry-run`, `--apply`, `status`, and peers) with both an execution disposition and an authority requirement.
- [ ] `OPERATION_SURFACE` remains the host/documentation catalog. Adding a host-table row is not sufficient to classify a command form.
- [ ] A new mutating registry keyword or documented mutating mode form without a disposition fails a contract test before any GitHub write.
- [ ] Every `supervised-lifecycle` form reports a typed operation observation to RecoverySupervisor and does not declare terminal mechanical failure.
- [ ] No `supervised-lifecycle` form silently terminates through raw `process.exit(1)` on a mechanical fault. Parser usage errors still exit 2 before mutation.
- [ ] Failed run-start preflight (`doctor.runOnStart` or `--doctor` on a drive) becomes a recoverable observation or a typed Capability Request. The Logical Operation stays owned. Standalone `pipeline doctor` still exits 1 when checks fail and does not write recovery state.
- [ ] `pipeline unblock`, `pipeline override`, and `pipeline handoff answer` resume through the existing typed-request resume contract. They do not add a second answer ledger.
- [ ] Every `bounded-atomic-administration` form documents why durable lifecycle ownership does not apply, finishes in one bounded transaction, leaves no active ownership, and is idempotent or fully reconcilable. A crash or failure fixture leaves no active run ownerless.
- [ ] `pipeline cleanup` preserves unknown state and does not remove or mutate a worktree held by a fenced live owner.
- [ ] `pipeline remove-worktree` (including `--force`) does not remove a worktree held by a fenced live owner.
- [ ] Read-only forms, including `status`, `summary`, `logs`, standalone `doctor`, `ship status`, and documented dry-run forms, do not create, update, or cancel recovery episodes, claims, Cooling, or typed requests.
- [ ] Command registry, parser dispatch, generated `docs/cli.md`, generated host SKILL tables, and executable behavior agree on the classified forms.
- [ ] At minimum the inventory includes intake, decompose, triage, sweep, queue, roadmap mutations, unblock, override, init, cleanup, remove-worktree, doctor, run-start preflight, release, engine promotion, and factory commands, including their dry-run/apply/status forms.
- [ ] No second RecoverySupervisor, command-grammar module, answer ledger, grant schema, or public inventory CLI verb is introduced.
- [ ] `node scripts/build.mjs` and `npm run ci` pass.
