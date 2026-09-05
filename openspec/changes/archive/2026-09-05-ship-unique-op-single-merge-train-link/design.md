## Context

See `proposal.md` for why.

#1440 persisted `single` / `merge` / `merge-queue` through `initRunDir`, mapped those prefixes, and joined followable `train_loop_linked` when the event or loaded child already carried a logical id. Live scored evidence `frg-2026-09-04T23-26-39-082Z-d9c7b762` still reports `missing_required_coverage = 4`:

- observed: `drive`, `loop`, `train` (515 operations)
- missing entrypoints: `single`, `merge`, `merge-queue`
- one #1301 live train-link (`train_loop_linked` exists; scored operations have no inherited child logical id)
- #1333 rows are already bound to `d0c5cb32` (out of scope)

Existing surfaces this change extends:

- `persistPublicEntrypointAdmission` / `initRunDir` in `run-store.ts` (today writes `runsDir(repoDir)`)
- `resolveFactoryControlRoot` / `resolveUniqueOperationRunsRoots` / `collectUniqueOperationsFromRunStore` in factory-gate / factory-release
- `attemptsFromRunArtifacts` / `followableChildLogicalId` / `aggregateUniqueOperationReliability` in `operation-reliability.ts`
- `uniqueOperationSloFailure` on prepare `frg_not_eligible`

Live facts that constrain the design:

- Collection reads loop state-home `<resolveStateHome()>/runs` and generic `runsDir(resolveFactoryControlRoot(...))`. It does not score candidate-worktree `runsDir(repoDir)` unless that path is one of those two roots.
- Public persist still uses command `cfg.repo_dir`. A worktree or candidate checkout is not the dual-root collection scores. Control-host `.agent-pipeline/runs` still has no `single-*` / `merge-*` / `merge-queue-*` prefixes.
- `followableChildLogicalId` returns `eventLogical ?? childMinted` and skips the join when both are empty. Historical `train_loop_linked` events often omit `logical_operation_id`. Historical children often have no minted id. The parent train already has a logical id. Scored `operations[]` do not carry `child_logical_operation_id`.

## Goals / Non-Goals

**Goals:**

- First holding rung: point existing persist at the same approved roots collection already reads. Inherit the parent train logical id on a followable `train_loop_linked` event. Put that id on the scored train operation. Do not add a second aggregator, FRG runner, scheduler, or run store.
- Keep fail-closed when those artifacts or that followable child are actually absent.

**Non-Goals:**

- Inventing unique-operation successes when host artifacts are absent.
- Coercing numeric drive or `kind: "advance"` to `single`.
- Treating nested `train_merge_*` events as public `merge` / `merge-queue`.
- Re-stamping #1333 inventory rows.
- Dropping `ship` from `REQUIRED_PUBLIC_ENTRYPOINTS`.
- Merging factory-gate pack PRs from recover paths.
- A new unique-operation CLI or store format.

## Decisions

### D1 — Persist public admissions into the dual-root collection already scores

Keep `persistPublicEntrypointAdmission` and `initRunDir`. Change the write root so public `pipeline single` / `pipeline merge` / `pipeline merge-queue` land in `runsDir(resolveFactoryControlRoot(...))` when that factory-control root is non-null. That is the same generic root `resolveUniqueOperationRunsRoots` already returns.

Do not treat command `cfg.repo_dir` as the unique-operation store when it is a candidate worktree or any other path outside the approved dual-root pair.

When factory-control root is null, the public command still runs. Unique-operation coverage stays fail-closed. Do not write a worktree artifact and claim that it satisfies `single` / `merge` / `merge-queue`.

Do not also write a second copy into loop state-home. Train and merge already live in the generic store. Duplicate `run_id` across roots is scored once.

Keep nested loop children of `pipeline single` as `loop`. Keep nested `train_merge_*` events nested under `train`.

Alternative considered: keep writing `runsDir(repoDir)` and teach collection to scan the candidate worktree. Rejected: #1434 / #1440 already forbade deriving the generic root from candidate-worktree `runsDir`. An empty worktree is not proof that those commands never ran; a populated worktree is not the control-host source of truth.

Alternative considered: observe `single` from the nested loop child. Rejected: mapping prefers start-event entrypoint and would steal `loop` coverage.

### D2 — Observe only real dual-root artifacts; keep the existing mapper

Keep `mapPublicEntrypoint` / `mapPublicEntrypointFromRunId`. Collection continues to map `run.json.kind`, `run_start.entrypoint`, and documented prefixes (`single-`, `merge-`, `merge-queue-` / `mq-`). Numeric drive stays `drive`. Unrecognized `kind` such as `advance` never becomes `single`.

Do not add a second mapper. Do not mint synthetic `single-*` / `merge-*` / `merge-queue-*` directories during ship scoring. Historical hosts that never admitted those public commands stay fail-closed until a real admission persists into the approved roots.

### D3 — Inherit the parent train logical id onto the scored operation

Extend the existing join in `attemptsFromRunArtifacts` (and the aggregator live-link increment). A `train_loop_linked` event is followable when:

1. `loop_run_id` is nonempty.
2. Events path is nonempty, absolute, and loads the linked child inside the approved dual-root pair.
3. A child logical id exists after inheritance: child's minted id when it differs from the train identity; otherwise the event's `logical_operation_id`; otherwise the **parent train operation's** logical id.

Do not require the event to restamp `logical_operation_id`. Do not require the child artifact to mint a logical id. Do not require the child's `run_id` fallback to equal the train minted id.

The scored train operation SHALL carry that followable child logical id (`child_logical_operation_id` on the unique-operation evidence operation). Live train-link increments only when that field is present on a followable join. Observing entrypoint `train` alone does not satisfy #1301.

A path that escapes the approved roots still does not load. An unrelated in-root events path still does not count. Collection does not invent `train_loop_linked`.

Alternative considered: stamp `live_train_linkage_present: true` on the in-flight manifest when any `train` artifact exists. Rejected: the issue forbids counting a `train` entrypoint without a followable child.

Alternative considered: guess the child by latest loop run. Rejected by #1301.

### D4 — Keep fail-closed SLO naming

Keep `uniqueOperationSloFailure` on prepare `frg_not_eligible`. Do not weaken missing coverage when persist never landed in an approved root or the train event is not followable.

## Risks / Trade-offs

- **[Risk] Control-host has never admitted `pipeline single` / `merge` / `merge-queue` after persist-root is fixed.** → Mitigation: producer root is the class fix. Live score stays fail-closed until a real admission writes into the dual-root. Do not mint coverage.
- **[Risk] Factory-control root is unset on a host that still runs those commands.** → Mitigation: command still executes. Unique-operation stays fail-closed. Do not fall back to candidate-worktree `runsDir`.
- **[Risk] Inheriting the parent logical id hides a contradictory child minted id.** → Mitigation: keep using the child's minted id when it differs from the train identity. Inheritance is only the fallback when event and child omit a minted id.
- **[Risk] `pipeline single` parent plus nested loop double-counts success.** → Mitigation: nested child inherits the parent logical id (existing law). Entrypoint observation can list both `single` and `loop` without a second verified success.

## Migration Plan

- No schema migration. New public admissions become visible after persist writes into the factory-control generic store.
- Unsigned `latest.json` with `pass: false` from the failed v1.40.1 pack remains fail until re-scored. Re-invoke `factory-release prepare` after this change; do not rewrite fail into pass.
- Tag/promote HMAC path unchanged.

## Open Questions

None. Persist-root alignment, inherit-from-parent train-link, and fail-closed SLO naming are decided.
