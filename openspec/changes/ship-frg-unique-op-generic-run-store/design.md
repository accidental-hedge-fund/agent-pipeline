## Context

See `proposal.md` for why.

#1428 pointed unique-operation collection at `resolveStateHome()/runs` (loop state-home) and deferred in-flight `ship`. Live control-host train/advance/merge artifacts live at `<control-repo>/.agent-pipeline/runs` (`runsDir`). Those artifacts omit `candidate_sha`, `logical_operation_id`, `kind`/`entrypoint` on historical advance runs, and `executed_matrix_rows`. `filterAttemptsBoundToCandidate` drops unbound artifacts when a scored SHA is set. `defaultScoreBoundPackLoop` sets `inFlightShip: true` and does not pass `uniqueOperationRunsRoot`. Direct `factory-gate --from-run` scores `operations.len = 0`.

Existing surfaces this change extends:

- `uniqueOperationRunsRoots` / `collectUniqueOperationsFromRunStore` in `factory-reliability-gate.ts`
- `filterAttemptsBoundToCandidate` / `attemptsFromRunArtifacts` / `mapPublicEntrypoint` in `operation-reliability.ts`
- `defaultScoreBoundPackLoop` in `factory-release-prepare.ts`
- `runsDir` (generic store) and `resolveFactoryControlRoot` / `REPO_DIR` / `AGENT_PIPELINE_FACTORY_CONTROL` (control-host root)
- `FAULT_RECOVERY_MATRIX`, `assertFaultRecoveryInventoryComplete`, `bindExecutedMatrixRowsForCandidate`
- `uniqueOperationSloFailure` / `uniqueOperationReleaseBindingFailure` and prepare `frg_not_eligible` text

## Goals / Non-Goals

**Goals:**

- First holding rung: extend the existing collector roots, binding filter, artifact mapper, inventory binder, and hard-gate text. Do not add a second aggregator, FRG runner, scheduler, or executed-row store.
- Read loop state-home **and** the control-host generic run store.
- Keep unbound host artifacts for in-flight ship coverage observation. Drop them for standalone factory-gate.
- Map public entrypoints from durable kind/entrypoint/run-id prefix. Use `run_id` as aggregation identity when `logical_operation_id` is absent.
- Feed #1333 coverage from a complete candidate-tree inventory through the existing executed-row binder.
- Keep unique-operation SLO/binding diagnostics on prepare `frg_not_eligible`.

**Non-Goals:**

- Weakening unique-operation SLOs when both host stores are empty.
- Stamping `passingUniqueOperationManifest().covered_lifecycle_classes`.
- Inventing `train_loop_linked` when the host train stream has no followable child.
- Changing scoreboard success-rate identity rules (historical missing-correlation stays unless a mapper mode keeps that path).
- Dropping `ship` from `REQUIRED_PUBLIC_ENTRYPOINTS`.
- Merging factory-gate pack PRs from recover paths.
- A new unique-operation CLI or store format.

## Decisions

### D1 — Dual collection roots: loop state-home plus control-host generic store

`uniqueOperationRunsRoots` SHALL return both:

1. Loop state-home `<resolveStateHome()>/runs` (pack loops, durable loop runs).
2. Control-host generic `<control-repo>/.agent-pipeline/runs` (`runsDir` of the factory-control root).

Resolve the control-host generic root from existing factory-control signals (`resolveFactoryControlRoot`, `AGENT_PIPELINE_FACTORY_CONTROL`, factory-plane `REPO_DIR`, optional `factoryControlDir`). Tests inject `uniqueOperationRunsRoot` as the generic-store seam.

In-flight ship SHALL NOT treat the candidate worktree `.agent-pipeline/runs` as unique-operation source of truth unless that path **is** the control-host generic root. #1428 `hostOnly` currently returns only state-home and therefore skips the generic store even when `repoDir` is the control checkout — that is the live miss.

`defaultScoreBoundPackLoop` SHALL pass enough context (injected generic root and/or env) that production prepare scores the generic store without a new CLI verb.

Alternative considered: copy host generic runs into the candidate worktree. Rejected: duplicates durable identity.

Alternative considered: replace state-home with the generic store. Rejected: pack loops still live in state-home; the issue requires **both**.

### D2 — In-flight ship keeps unbound host attempts; standalone factory-gate drops them

Extend `filterAttemptsBoundToCandidate` (or its in-flight-ship caller) so that when `inFlightShip` is true:

- Attempts with empty `candidate_sha` are kept.
- Attempts with empty release identity are kept when the scored release identity is set.
- Attempts bound to a **different** candidate SHA are still dropped.
- Attempts with a present mismatched release identity are still dropped.

When `inFlightShip` is false (standalone factory-gate), unbound and missing-release artifacts still drop.

Alternative considered: stamp the current pack candidate SHA onto unbound runs. Rejected: #1428 already forbade stamping later provenance. Keeping unbound for in-flight coverage is not stamping.

Alternative considered: keep unbound for every FRG score. Rejected: standalone factory-gate must stay fail-closed on unbound artifacts.

### D3 — Shared mapper: entrypoint from kind / event / run-id prefix; `run_id` fallback identity

Extend `attemptsFromRunArtifacts` (first holding rung; do not write a second mapper):

- Entrypoint: `mapPublicEntrypoint(run_start.entrypoint)` then `mapPublicEntrypoint(run.json.kind)` then a stable run-id prefix: `train-` → `train`, `loop-` → `loop`, `merge-queue-` / `mq-` → `merge-queue`, remaining `merge-` → `merge`, numeric drive `<issue>-<timestamp>` → `drive`. Do not coerce `kind: "advance"` to `single`.
- When no durable `logical_operation_id` exists, use `run_id` as `logical_operation_id` so the attempt is aggregable. This is a physical-run fallback identity, not a new admission mint and not verified success.

Keep scoreboard historical missing-correlation: if the shared mapper would change scoreboard success-rate identity, use an explicit FRG/in-flight mode on the same function rather than a second mapper.

Alternative considered: infer entrypoint only from `kind`. Rejected: live advance `run.json` often omits `kind`; prefixes are the durable identity that already exists (`trainRunIdFor`, `runIdFor`, loop `loop-`, merge-queue `mq-`).

### D4 — Fallback-identity host artifacts observe entrypoints; they are not ownerless unique-ops

If fallback-identity attempts were classified as ordinary unique operations, they would increment `ownerless_terminal` (no `postcondition_proof`) and still fail `uniqueOperationSloFailure`. That would leave v1.40.1 blocked after D1–D3.

In-flight ship scoring SHALL treat those kept host artifacts as **entrypoint coverage observation**:

- They populate `entrypoint_coverage.observed`.
- They SHALL NOT increment `missing_correlation` solely for a missing minted logical id.
- They SHALL NOT increment `ownerless_terminal` solely for lack of `postcondition_proof`.
- They SHALL NOT count as verified unique-operation success.
- They SHALL NOT become a stable exclusion.

Standalone factory-gate does not take this path because D2 drops the unbound artifacts first.

### D5 — In-flight #1333 rows come from a complete candidate-tree inventory through the existing binder

Live hosts have no durable `executed_matrix_rows` for the scored SHA. #1428 D4 left that fail-closed. That is the remaining class gap after D1–D4.

When scoring is in-flight ship **and** `assertFaultRecoveryInventoryComplete` passes for the candidate tree's `FAULT_RECOVERY_MATRIX`, map applicable inventory rows to `executed_matrix_rows` with `candidate_sha` equal to the scored SHA, then pass them through `bindExecutedMatrixRowsForCandidate`. Do not stamp `passingUniqueOperationManifest().covered_lifecycle_classes`. Incomplete inventory SHALL NOT attach rows.

Standalone factory-gate SHALL NOT mint inventory rows. Absence of durable executed rows there stays missing required coverage.

This is not a second matrix runner. The inventory already declares covering cells; the binder already accepts executed rows that match those cells.

### D6 — Hard-gate text keeps SLO/binding diagnostics on `frg_not_eligible`

`generateDurableUnsignedFrg` already appends `uniqueOperationSloFailure` / `uniqueOperationReleaseBindingFailure`. The prepare CLI path that falls back to `generated.message ?? "FRG structural eligibility failed for <ver>"` SHALL NOT emit that bare sentence when those diagnostics exist. A regression test fails if `frg_not_eligible` message equals only the generic hard-gate sentence while SLO/binding strings are non-null.

Do not reimplement SLO checks in prepare.

### D7 — Tests inject host run stores

Hermetic tests MUST inject fs/run-store seams (no network, git, or subprocess):

1. Empty candidate-worktree runs + populated control-host generic runs under `inFlightShip` → required public entrypoints observed.
2. Unbound train/loop artifacts kept for in-flight ship and dropped for standalone factory-gate.
3. Complete inventory → all five #1333 classes covered for the request candidate SHA; helper stamps still fail.
4. Prepare `frg_not_eligible` message includes SLO/binding text (not only the bare fallback).
5. Both host stores empty → still fail-closed.

## Risks / Trade-offs

- **[Risk] `resolveFactoryControlRoot` is unset on a host that still has generic runs under `repoDir`.** → Mitigation: when `repoDir` itself holds the generic store (`runsDir(repoDir)`) and is not a candidate-only worktree skip, include it. Tests inject the generic root explicitly.
- **[Risk] Run-id fallback collapses retries into many unique operations on the scoreboard.** → Mitigation: D3 keeps scoreboard on the current missing-correlation path; fallback identity is for in-flight FRG coverage observation (D4).
- **[Risk] Inventory-derived #1333 rows are mistaken for a helper stamp.** → Mitigation: rows must bind to declared cells through `bindExecutedMatrixRowsForCandidate`; `passingUniqueOperationManifest().covered_lifecycle_classes` still fails; incomplete inventory fails closed.
- **[Risk] Host train stream still lacks followable `train_loop_linked`.** → Mitigation: this change does not invent #1301 linkage. If that stream is present, existing follow rules apply. If it is absent after D1–D5, the hard-gate names that coverage gap (D6) rather than an empty collector.
- **[Risk] In-flight unbound-keep is copied onto standalone factory-gate.** → Mitigation: D2 is gated on `inFlightShip`. Tests fail if standalone keeps unbound artifacts.

## Migration Plan

- No schema migration. Existing control-host generic runs become visible to in-flight ship FRG scoring.
- Unsigned `latest.json` with `pass: false` from the failed v1.40.1 pack remains fail until re-scored. Re-invoke `factory-release prepare` after this change; do not rewrite fail into pass.
- Tag/promote HMAC path unchanged.

## Open Questions

None. Dual roots, in-flight unbound keep, mapper fallback, inventory-bound #1333 rows, and hard-gate text are decided. File-level helper names are implementation.
