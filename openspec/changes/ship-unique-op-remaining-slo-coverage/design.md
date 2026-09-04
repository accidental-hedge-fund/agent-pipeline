## Context

See `proposal.md` for why.

#1434 made dual-root host collection work. Live scored evidence `frg-2026-09-04T20-58-57-132Z-ea1bcc25` still reports `missing_required_coverage = 9`:

- observed: `drive`, `loop`, `train` (512 operations)
- missing entrypoints: `single`, `merge`, `merge-queue`
- five #1333 classes (`executed_matrix_rows` empty)
- one #1301 live train-link (`train_loop_linked` exists on the train stream; scored operations have no train-link)

Existing surfaces this change extends:

- `initRunDir` / `RunKind` (`"advance" | "train"`) / `trainRunIdFor` in `run-store.ts`
- `attemptsFromRunArtifacts` / `mapPublicEntrypoint` / `mapPublicEntrypointFromRunId` / `trainLinkedEventRefs` / `aggregateUniqueOperationReliability` in `operation-reliability.ts`
- `collectUniqueOperationsFromRunStore` / `loadFollowableChildRun` / `executedRowsFromCompleteInventory` in `factory-reliability-gate.ts`
- `defaultLoadCandidateFaultRecoveryInventory` / `defaultScoreBoundPackLoop` in `factory-release-prepare.ts`
- `FAULT_RECOVERY_MATRIX` / `assertFaultRecoveryInventoryComplete` / `bindExecutedMatrixRowsForCandidate`

Live facts that constrain the design:

- Control-host `.agent-pipeline/runs` has `train-*` (`kind: "train"`) and numeric advance ids (mapped to `drive`). There are no `merge-*` / `merge-queue-*` / `single-*` prefixes. `RunKind` cannot store those kinds. `pipeline merge` / `merge-queue` do not call `initRunDir`. `pipeline single` drives a nested loop (mapped as `loop`).
- `attemptsFromRunArtifacts` sets `train_loop_linked` only when the child is in the scanned set **and** `artifactLogicalId(child) ===` the train minted id. Historical children often have no minted id (`run_id` fallback). The join then drops a followable event.
- `defaultLoadCandidateFaultRecoveryInventory` returns empty rows when checkout HEAD is not the scored SHA, even though `git show <sha>:<inventory>` can load the commit-bound blob. Unit tests inject a matching fake SHA, so they do not catch the live from-run miss.

## Goals / Non-Goals

**Goals:**

- First holding rung: extend the existing run store, mapper, train-link join, and inventory loader. Do not add a second aggregator, FRG runner, scheduler, or executed-row store.
- Persist recognizable `single` / `merge` / `merge-queue` artifacts through `initRunDir` so collection can observe them. Map `single-` the same way `merge-` / `merge-queue-` already map.
- Count live train-link from a followable `train_loop_linked` event (absolute events path + child logical id). Keep fail-closed when the child is not followable.
- Attach #1333 rows from the commit-bound blob at the scored SHA on a live from-run score, including when HEAD differs.

**Non-Goals:**

- Inventing unique-operation successes when host artifacts are absent.
- Coercing numeric drive or `kind: "advance"` to `single`.
- Treating nested `train_merge_*` events as public `merge` / `merge-queue`.
- Stamping `passingUniqueOperationManifest().covered_lifecycle_classes`.
- Dropping `ship` from `REQUIRED_PUBLIC_ENTRYPOINTS`.
- Merging factory-gate pack PRs from recover paths.
- A new unique-operation CLI or store format.

## Decisions

### D1 — Persist `single` / `merge` / `merge-queue` through existing `initRunDir`

Extend `RunKind` and `initRunDir` so public admission of `pipeline single`, `pipeline merge`, and `pipeline merge-queue` writes a control-host generic-store run with `kind` plus a stable prefix (`single-`, `merge-`, `merge-queue-` / `mq-`), using the same timestamp helper as `trainRunIdFor`. Nested loop children of `single` keep their `loop-` identity. Nested train merge events stay nested under `train`.

Do not map numeric drive ids to `single`. `pipeline N` remains `drive`. `pipeline single` is a distinct public admission.

Do not map `merge-queue-repair-pr-*` helper ids to `merge-queue`.

Alternative considered: observe `single` from the nested loop run by stamping `entrypoint: "single"` on the loop artifact. Rejected: mapping prefers start-event entrypoint, which would steal `loop` coverage from that artifact.

Alternative considered: treat train merge-mode events as public `merge`. Rejected: nested child work inherits the train identity and is not a public `pipeline merge` admission. That would invent coverage.

Historical host stores that never ran those commands stay fail-closed until a real admission persists an artifact. Collection does not mint synthetic successes.

### D2 — Mapper first holding rung: add `single-` beside existing prefixes

Extend `mapPublicEntrypointFromRunId` only. Precedence stays: recognized `run_start.entrypoint`, then recognized `run.json.kind`, then prefixes. Add `single-` next to `train-` / `loop-`. Keep `merge-queue-` / `mq-` before remaining `merge-`. Numeric drive stays `drive`. Unrecognized `kind` such as `advance` still falls through and never becomes `single`.

Do not write a second mapper.

### D3 — Followable train-link join uses the event identity, not child `run_id` fallback equality

Extend the existing join in `attemptsFromRunArtifacts` (and the aggregator live-link increment). A `train_loop_linked` event is followable when:

1. `loop_run_id` is nonempty.
2. Events path is nonempty, absolute, and `loadFollowableChildRun` loads the child inside the approved dual-root pair.
3. A child logical id exists: the child's minted `logical_operation_id` when it equals the train identity, otherwise the event's `logical_operation_id` (the inherited parent identity already published on the event).

Do not require `artifactLogicalId(child) ===` train minted id when the child has no minted id. Do not increment contradictory correlation solely because the child's `run_id` fallback (`loop-…`) differs from the train minted id.

A train attempt with no followable child does not count. Paths that escape the approved roots still do not load.

Alternative considered: stamp `live_train_linkage_present: true` on the in-flight manifest when any `train` artifact exists. Rejected: the issue forbids counting a `train` entrypoint without a followable child.

Alternative considered: guess the child by latest loop run. Rejected by #1301.

### D4 — Inventory loader binds `sourceSha` to the commit blob, not checkout HEAD

Change `defaultLoadCandidateFaultRecoveryInventory` so it loads `git show <candidateSha>:<inventory>` (existing non-executing parser) and returns `sourceSha: candidateSha` when that blob parses. Do not return empty rows solely because checkout HEAD differs from `candidateSha`. Keep: dirty worktree must not replace the blob; invalid blob attaches nothing; `sourceSha` that is not the scored SHA still fails closed; standalone factory-gate still does not mint rows.

Prove on a live `--from-run` / `defaultScoreBoundPackLoop` score where HEAD is not the scored SHA. Hermetic unit tests inject a blob at SHA `C` with checkout HEAD `H ≠ C` and fail if rows stay empty.

Alternative considered: check out the candidate SHA before scoring. Rejected: ship/from-run scores a packed candidate from a control worktree that is often not at that SHA. The blob load already names the SHA.

Alternative considered: keep the HEAD gate and only relax it in tests. Rejected: that is the live miss.

### D5 — Keep fail-closed SLO naming

Keep `uniqueOperationSloFailure` on prepare `frg_not_eligible`. Do not weaken missing coverage when artifacts, followable children, or complete blobs are actually absent.

## Risks / Trade-offs

- **[Risk] Control-host has never admitted `single` / `merge` / `merge-queue`.** → Mitigation: producer persistence is the class fix. Live score stays fail-closed until a real admission writes artifacts. Do not mint coverage.
- **[Risk] `pipeline single` parent run plus nested loop double-counts success.** → Mitigation: nested child inherits the parent logical id (existing law). Entrypoint observation can list both `single` and `loop` without a second verified success.
- **[Risk] Followable join treats a dangling absolute path as live train-link.** → Mitigation: `loadFollowableChildRun` must succeed inside approved roots. Missing child is not followable.
- **[Risk] Inventory blob at an unscored SHA is attached because HEAD is ignored.** → Mitigation: `sourceSha` must equal the scored SHA. Other-SHA blobs still fail.
- **[Risk] In-flight exceptions leak onto standalone factory-gate.** → Mitigation: keep `opts.inFlightShip === true` as the only gate for unbound keep and inventory attach.

## Migration Plan

- No schema migration. New `single` / `merge` / `merge-queue` runs become visible after those commands persist artifacts.
- Unsigned `latest.json` with `pass: false` from the failed v1.40.1 pack remains fail until re-scored. Re-invoke `factory-release prepare` after this change; do not rewrite fail into pass.
- Tag/promote HMAC path unchanged.

## Open Questions

None. Producer persistence through `initRunDir`, mapper `single-` prefix, followable train-link join, and commit-blob inventory load are decided.
