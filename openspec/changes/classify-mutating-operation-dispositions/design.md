## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- `core/scripts/command-registry.ts` — dispatch metadata (`needsIssueNumber`, `allowedFlags`, `mutatesGitHub`, `needsConfig`, `needsGhAuth`, `supportsJson`). One entry per keyword. `mutatesGitHub` is a boolean and cannot classify mode forms.
- `core/scripts/command-docs.ts` — co-located documentation map keyed by the same keywords. Adding docs metadata does not change `validateFlags`.
- `core/scripts/operation-surface.ts` — host and SKILL catalog. `CONTEXT.md` already states it is not the complete inventory.
- RecoverySupervisor vocabulary in `CONTEXT.md` (#1323) and adapter observation types already used by `core/scripts/stages/merge-supervision.ts` and `core/scripts/stages/ship-supervision.ts`. This change does not invent a second owner.
- Typed-request resume in `human-question-handoff` (`pipeline handoff answer` plus resume validation).
- Inventory-plus-drift-guard pattern in `core/scripts/ship-path-composition-coverage.ts` and `core/scripts/fault-recovery-matrix.ts`.
- Static lifecycle-exit scan in `core/scripts/fault-recovery-static-guards.ts` (`collectCommandLocalLifecycleExits`). Today it only walks `scripts/stages` and only matches `mechanical|recovery|exhaust` near `process.exit`.
- Run-start preflight in `runStartPreflightGate`: on failure it returns `{ proceed: false }` and the CLI aborts before planning. Standalone `pipeline doctor` may exit 1.
- `pipeline cleanup` → `sweepMergedWorktrees`. `pipeline queue` starts nested drives and currently `process.exit(1)` on config errors.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: a co-located command-form inventory next to `COMMAND_REGISTRY`, not a third command-grammar module.
- Two independent classifications per form. Mode forms (`--dry-run`, `--apply`, `status`) are first-class keys.
- Supervised forms become RecoverySupervisor adapters. Bounded-atomic forms stay one-shot with an ownership proof. Read-only forms cannot write recovery state.
- Expand the existing static lifecycle-exit guard to every supervised command module.
- Route unblock, override, and answers through the existing handoff resume contract.

**Non-Goals:**

- A new public inventory CLI verb.
- A second RecoverySupervisor, answer ledger, grant schema, or scheduler.
- Forcing `status`, `logs`, standalone `doctor`, or documented dry-run forms through mutation scheduling.
- Treating every administrative command as a long-running workflow.
- Host-specific command policy.
- Reimplementing #1323, #1328 issue-advancement migration, #1331 ship phases, #1332 liveness, or #1333 fault matrix.
- Collapsing execution disposition into `mutatesGitHub`.

## Decisions

### D1 — Co-located form inventory; `COMMAND_REGISTRY` stays dispatch

Add a co-located TypeScript inventory (same rung as `command-docs.ts`) keyed by **command form id**, not by top-level keyword alone. `COMMAND_REGISTRY` remains the dispatch and flag-validation source. `OPERATION_SURFACE` remains the host/docs catalog.

Form ids cover:

- every `COMMAND_REGISTRY` key
- default numeric invocation (`advance`)
- nested subcommands (`handoff answer`, `loop logs`, `release finish`, `ship status`, `factory-pin rollback`, and peers)
- documented mode forms (`decompose.apply`, `decompose.dry-run`, `merge-queue.apply`, `grill.status`, and peers)
- flag-only aliases (`--cleanup` → `cleanup`, `--remove-worktree` → `remove-worktree`, `--init` → `init`)

Do not add `pipeline inventory` or a JSON/YAML sidecar. Tests import the TypeScript inventory, matching `ship-path-composition-coverage.ts`.

Alternative considered: put `executionDisposition` on `CommandEntry`. Rejected: one keyword has multiple forms (`decompose` dry-run vs `--apply`; `ship` vs `ship status`). A keyword-level bit would mis-classify dry-run as supervised or apply as read-only.

Alternative considered: make `OPERATION_SURFACE` the inventory. Rejected: the issue decision and `CONTEXT.md` keep it as the host catalog. It omits `queue`, `handoff`, `evals`, `correction`, `single`, numeric `advance`, and mode forms.

### D2 — Two independent axes

Each form records:

| Axis | Closed set |
| --- | --- |
| `execution_disposition` | `read-only` \| `bounded-atomic-administration` \| `supervised-lifecycle` |
| `authority_requirement` | `none` \| `typed-response` \| `protected-authority` |

The problem statement's "typed answer or authority operation" is the authority axis, not a fourth execution class.

`mutatesGitHub: true` does not imply `supervised-lifecycle`. Intake `--apply` mutates GitHub and is bounded-atomic because it leaves no active run owner. `loop` currently declares `mutatesGitHub: false` and is still `supervised-lifecycle` because it owns nested drives.

### D3 — Bounded-atomic vs supervised is about leftover ownership

A form MAY be `bounded-atomic-administration` only when all of these hold:

1. It finishes in one bounded transaction.
2. Success or failure leaves **no active Logical Operation ownership**.
3. It is idempotent or fully reconcilable against the authoritative observer.
4. The inventory row documents why durable lifecycle ownership does not apply.

Everything else that can leave an active Logical Operation is `supervised-lifecycle`. Mechanical failure and retry exhaustion do not end that ownership.

Admission writes that do not start a run (init labels, triage stage label, intake issue create, decompose `--apply`, sweep `--apply`, roadmap `--apply`) are bounded-atomic when they meet the four tests. Starting or driving a run (`advance`, `single`, `loop`, `queue`, `train`, `ship`, `grill` admit, `override` re-entry, `recover-parked`) is supervised.

### D4 — Minimum inspect-list dispositions

These are the required rows for the issue inspect list. Other registry forms follow the same rules.

| Form | Execution | Authority | Ownership note |
| --- | --- | --- | --- |
| `advance`, `single`, `run` | supervised-lifecycle | none | durable one-item drive |
| `loop` (drive) | supervised-lifecycle | none | durable multi-item drive |
| `loop.logs` | read-only | none | observation only |
| `train` | supervised-lifecycle | none; `--merge` is protected-authority | already a RecoverySupervisor adapter |
| `train.dry-run` | read-only | none | |
| `merge` | supervised-lifecycle | protected-authority | already a RecoverySupervisor adapter |
| `merge-queue` / `merge-queue.dry-run` | read-only | none | dry-run remains default |
| `merge-queue.apply` | supervised-lifecycle | protected-authority | |
| `ship` | supervised-lifecycle | protected-authority | |
| `ship.status` | read-only | none | projection only |
| `recover-parked` | supervised-lifecycle | none | operator CLI; never merge |
| `override` | supervised-lifecycle | typed-response (class policy may require protected-authority) | resume via typed-request contract |
| `unblock` | supervised-lifecycle | typed-response | resume via typed-request contract |
| `handoff.list`, `handoff.show` | read-only | none | |
| `handoff.answer`, `handoff.reject`, `handoff.supersede` | supervised-lifecycle | typed-response or protected-authority | existing resume contract |
| `intake` | bounded-atomic-administration | none | creates issue/PR; no run owner |
| `intake.dry-run` | read-only | none | |
| `decompose` / `decompose.dry-run` | read-only | none | dry-run is default |
| `decompose.apply` | bounded-atomic-administration | none | children + ROADMAP; no run owner |
| `triage` | bounded-atomic-administration | none | one admission label write |
| `sweep` / `sweep.dry-run` | read-only | none | |
| `sweep.apply` | bounded-atomic-administration | none | |
| `roadmap` / `roadmap.dry-run` | read-only | none | |
| `roadmap.apply` | bounded-atomic-administration | none | |
| `queue` | supervised-lifecycle | none | starts nested drives |
| `init` | bounded-atomic-administration | none | labels + scaffold |
| `cleanup` | bounded-atomic-administration | none | skip unknown and live-owned |
| `remove-worktree` | bounded-atomic-administration | none | refuse fenced live owner, including `--force` |
| `doctor` | read-only | none | standalone diagnostic; exit 1 allowed |
| run-start preflight | not a form | n/a | gate on a supervised drive; see D6 |
| `release.dry-run` | read-only | none | |
| `release`, `release.finish` | supervised-lifecycle | protected-authority | |
| `engine-promote.dry-run` | read-only | none | |
| `engine-promote` | supervised-lifecycle | none; rollback is protected-authority | existing RecoverySupervisor deployment law |
| `factory-gate` | bounded-atomic-administration | none | writes evidence; no run owner |
| `factory-release` | supervised-lifecycle | none | prepare-only; never merges |
| `factory-pin.show` | read-only | none | |
| `factory-pin.init`, `factory-pin.promote` | bounded-atomic-administration | none | pin JSON |
| `factory-pin.rollback` | supervised-lifecycle | protected-authority | |
| `grill.dry-run`, `grill.status` | read-only | none | |
| `grill` | supervised-lifecycle | none; unresolved authority nodes are typed-response | |
| `status`, `summary`, `logs`, `path`, `scoreboard`, `controls`, `liveness.status` | read-only | none | |
| `liveness.restore` | bounded-atomic-administration | none | restores a worker; does not choose recovery policy |

Hidden or undocumented aliases (`run`) inherit the canonical form's disposition.

### D5 — Supervised adapters report observations; they do not `process.exit(1)` as lifecycle terminal

Reuse the observation shape already used by merge and ship supervision: invariant, candidate binding, side-effect certainty, and ingress evidence. Command modules do not choose Cooling, wait, typed request, or cancellation.

Parser usage errors (unknown flag, missing argument) still exit 2 **before** mutation. That exit is not a lifecycle terminal.

Standalone read-only diagnostics (`pipeline doctor`, `status`) may still set `process.exitCode` 1. Bounded-atomic forms may return non-zero when the one-shot transaction fails, provided no active run is left ownerless.

Expand `collectCommandLocalLifecycleExits` beyond `scripts/stages` so `pipeline.ts` handlers and other command modules cannot silently `process.exit(1)` on a supervised mechanical fault.

### D6 — Run-start preflight is a gate, not a command form

`doctor.runOnStart` and `pipeline N --doctor` are modifiers on a supervised drive. They are not inventory keys.

On check failure:

- Do not enter planning. Do not spend implementer or reviewer tokens.
- Report a typed operation observation, or a Capability Request when the failure is an unavailable external capability (auth, harness, repo access).
- Keep the Logical Operation owned (Cooling or external-condition wait).
- Do not treat the CLI non-zero projection as ownerless STOP.

Standalone `pipeline doctor` stays read-only and may exit 1. It MUST NOT write recovery episodes.

Warn-level doctor results still do not block the drive (existing law).

### D7 — Unblock, override, and answers reuse handoff resume

Do not add `pipeline unblock-resume` or a second ledger.

- `handoff answer` already has resume validation (status, SHA, hashes, expiry, supersession, `resume_target`).
- `override` records a governed disposition, then resumes through that contract instead of a command-local `runAdvance` that can terminalize on the next fault.
- `unblock` posts the answer as a typed-request fulfillment (or binds to the current handoff) and resumes through the same contract instead of only clearing `pipeline:blocked` and returning.

Kill-switch behavior on unblock/override stays: no mutation when the domain kill-switch file is present.

### D8 — Cleanup and remove-worktree fence live owners and unknown state

**Fenced live owner** reuses existing host-local fences: the unified issue-run lock (`/tmp/pipeline-{domain}-{N}.lock` with a live PID) and the live-planning marker. This change does not invent a cross-host lock.

Cleanup (`sweepMergedWorktrees`):

- Removes only pipeline-managed worktrees whose PR is merged, that are clean, whose state is classified, and that have no fenced live owner.
- Skips unknown or unclassified worktree state. It does not delete "to be safe".
- Skips a fenced live owner even if GitHub says the PR is merged.
- Remains bounded-atomic and idempotent. Failure or skip leaves the live run owned.

`remove-worktree`, including `--force`, refuses a fenced live owner. Dirty-tree `--force` still cannot evict a live owner.

### D9 — Drift-guards that bite

Hermetic tests MUST fail when:

- a `COMMAND_REGISTRY` key has no form
- a documented nested subcommand or mode form (`--apply`, `--dry-run`, `status`) has no form
- a mutating form (`execution_disposition !== read-only`) is missing either axis
- `OPERATION_SURFACE` names a verb with no inventory form (host catalog ⊆ inventory)
- parser dispatch keywords are not a subset of inventory keywords
- generated `docs/cli.md` or host SKILL usage contradicts a form's dry-run/apply/status classification
- a supervised module uses lifecycle `process.exit(1)` on a mechanical fault
- cleanup removes unknown or live-owned state
- remove-worktree removes a live-owned worktree
- a read-only form writes a recovery episode, claim, Cooling record, or typed request
- run-start preflight failure leaves the drive ownerless
- unblock/override resume bypasses the typed-request contract

#1333 consumes this inventory as the operation dimension. This change does not reimplement the matrix.

## Risks / Trade-offs

- **[Risk] #1323 RecoverySupervisor is still a forthcoming module.** → Mitigation: emit the observation types `CONTEXT.md` already names and that merge/ship supervision already use. Do not ship a second policy owner. Implementation tasks that call RecoverySupervisor APIs wait on that module in the same milestone graph.
- **[Risk] Cartesian explosion of forms.** → Mitigation: enumerate documented nested verbs and documented mode forms, not every flag combination. `--json` is not a form. `--doctor` on a drive is a gate (D6), not a form.
- **[Risk] `mutatesGitHub` and disposition disagree and confuse callers.** → Mitigation: keep `mutatesGitHub` as the GitHub-write bit for flag validation and kill-switch. Tests assert the two axes are independent. Do not delete `mutatesGitHub`.
- **[Risk] Expanding the static exit guard flags legitimate diagnostic exits.** → Mitigation: the guard applies to `supervised-lifecycle` modules on mechanical/recovery/exhaustion paths. Read-only and bounded-atomic documented non-zero exits remain allowed. Parser exit 2 remains allowed.
- **[Trade-off] Intake, triage, and decompose `--apply` are bounded-atomic, not supervised.** → They mutate GitHub but cannot leave an active run ownerless. If a later issue proves they start owned work, reclassify that form; the contract test will require the new row.

## Migration Plan

1. Land the inventory with every current `COMMAND_REGISTRY` key and the inspect-list mode forms (red if any mutating form is missing).
2. Wire supervised inspect-list forms (queue, unblock, override, release, engine-promote, factory-release, grill admit) to RecoverySupervisor observations. Keep merge/train/ship adapters.
3. Convert run-start preflight failure to an observation or Capability Request without entering planning.
4. Route unblock/override through handoff resume validation.
5. Add cleanup unknown-state skip and live-owner fences; fence `remove-worktree`.
6. Expand the static lifecycle-exit guard. Delete command-local `process.exit(1)` terminals on supervised mechanical faults only after the replacement observation exists.
7. Align generated docs (`node scripts/build.mjs`) so dry-run/apply/status text matches the inventory.
8. `npm run ci` must pass.

Rollback: the inventory is additive. Restoring a command-local `process.exit(1)` on a supervised mechanical fault is not an allowed rollback.

## Open Questions

None. Remaining sequencing (#1323, #1328, #1333) is fail-closed consumption, not an open design choice.
