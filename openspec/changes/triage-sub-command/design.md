## Context

The pipeline CLI has a well-established sub-command pattern: a positional keyword is detected early in the dispatch block (`isReleaseCommand`, `isIntakeCommand`, etc.), a dedicated `stages/<name>.ts` handler is imported and called, and all external I/O is injectable via a `<Name>Deps` interface. The `triage` sub-command follows the same shape with one difference: unlike `release`, `intake`, and `sweep`, it takes a required issue number as a second positional argument alongside the keyword.

## Goals / Non-Goals

**Goals:**
- Add `triage` as a fully-exercised sub-command using the existing dispatch and injectable-deps patterns.
- Restrict settable stages to `backlog` and `ready` — the only pre-pipeline stages not owned by the advance state machine.
- Keep the command deterministic (no model calls) so all behavior is unit-testable.
- Idempotency: re-running against an already-correct issue is a no-op.

**Non-Goals:**
- Setting mid-flight stage labels (`planning`, `plan-review`, `implementing`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`) — those are owned by the state machine.
- Any GitHub UI / pipeline-desk change (tracked separately).
- Bulk triage of multiple issues in one invocation.
- `--dry-run` mode (the command has no expensive side-effectful preparation; idempotency already makes re-runs safe).

## Decisions

**Decision: `triage` takes a positional issue number rather than using the no-issue-number pattern.**
`release`, `intake`, and `sweep` need no issue number because they act on the repo or full backlog. `triage` acts on a specific issue, so it follows the normal `pipeline <N>` argument shape — the keyword `triage` is the first positional, the issue number is the second. This is detected early (before the normal advance loop) by `isTriageCommand = numArg === "triage"`.

**Decision: pre-pipeline stages are strictly `backlog` and `ready`.**
The `STAGES` constant defines the full ordered sequence. `backlog` is the triage-only marker; `ready` is the opt-in gate for the advance loop. Every stage from `planning` onward is owned by the state machine. The handler validates the `--stage` value against an explicit allowlist (`["backlog", "ready"]`) at the flag-parse boundary and exits non-zero if the value is anything else.

**Decision: idempotent label set — compare current labels, only write when needed.**
GitHub issue labels are additive. The handler fetches the issue's current labels, computes the set of current `pipeline:*` labels, and acts only if the current set differs from the desired state (exactly the target label, no others). If the desired state is already achieved, the handler logs "already set" and exits 0 without calling any GitHub write API. Otherwise it removes all current `pipeline:*` labels and adds the target.

**Decision: injectable deps seam covers all external calls.**
Following the `ReleaseDeps` / `ShaGateDeps` pattern: `TriageDeps` injects `getIssueLabels`, `addLabel`, `removeLabel`, and `log`. Production builds `realTriageDeps()`. Tests supply fakes. No network or subprocess in unit tests.

## Risks / Trade-offs

- *Operator can force-reset a mid-flight issue to `backlog`/`ready`* — the `--stage` guard blocks setting mid-flight stages as the target, but does not prevent removing a mid-flight label when replacing it with `backlog` or `ready`. This is intentional: an operator may need to rewind a stuck issue. The state machine will re-run normally from the new label on next invocation.
- *Race with the advance loop* — if the advance loop and `triage` run concurrently against the same issue, one label write may be overwritten. This is an inherent risk of any direct-label manipulation and is acceptable for an infrequent manual operation. No locking mechanism is introduced.
