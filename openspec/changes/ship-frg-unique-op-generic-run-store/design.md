## Context

See `proposal.md` for why.

#1428 pointed unique-operation collection at `resolveStateHome()/runs` (loop state-home) and deferred in-flight `ship`. Live control-host train/advance/merge artifacts live at `<control-repo>/.agent-pipeline/runs` (`runsDir`). Those artifacts omit `candidate_sha`, `logical_operation_id`, `kind`/`entrypoint` on historical advance runs, and `executed_matrix_rows`. `filterAttemptsBoundToCandidate` drops unbound artifacts when a scored SHA is set. `defaultScoreBoundPackLoop` sets `inFlightShip: true` and does not pass a generic-store root. Direct `factory-gate --from-run` scores `operations.len = 0`.

Existing surfaces this change extends:

- `uniqueOperationRunsRoots` / `collectUniqueOperationsFromRunStore` / `pathInsideApprovedRunsRoot` / `loadFollowableChildRun` in `factory-reliability-gate.ts`
- `filterAttemptsBoundToCandidate` / `attemptsFromRunArtifacts` / `mapPublicEntrypoint` / `aggregateUniqueOperationReliability` in `operation-reliability.ts`
- `defaultScoreBoundPackLoop` in `factory-release-prepare.ts` and CLI `runFactoryGate` in `pipeline.ts`
- `runsDir` (generic store) and `resolveFactoryControlRoot` / `REPO_DIR` / `AGENT_PIPELINE_FACTORY_CONTROL` (control-host root)
- `FAULT_RECOVERY_MATRIX`, `assertFaultRecoveryInventoryComplete`, `bindExecutedMatrixRowsForCandidate`
- `uniqueOperationSloFailure` / `uniqueOperationReleaseBindingFailure` and prepare `frg_not_eligible` text
- Runbook `docs/factory-reliability-gate-runbook.md`

## Goals / Non-Goals

**Goals:**

- First holding rung: extend the existing collector roots, binding filter, artifact mapper, inventory binder, and hard-gate text. Do not add a second aggregator, FRG runner, scheduler, or executed-row store.
- Read loop state-home **and** the control-host generic run store through an injectable resolver. Canonicalize those two roots. Do not derive the generic root from the candidate worktree `runsDir`.
- Keep unbound host artifacts for in-flight ship coverage observation. Drop them for standalone factory-gate.
- Map public entrypoints from recognized kind/entrypoint, then run-id prefix. Use `run_id` as aggregation identity with explicit fallback provenance when `logical_operation_id` is absent.
- Feed #1333 coverage from a complete candidate-tree inventory through the existing executed-row binder. The inventory tree SHA must match the scored SHA.
- Keep unique-operation SLO **and** binding diagnostics on prepare `frg_not_eligible`.

**Non-Goals:**

- Weakening unique-operation SLOs when both host stores are empty.
- Stamping `passingUniqueOperationManifest().covered_lifecycle_classes`.
- Inventing `train_loop_linked` when the host train stream has no followable child.
- Changing scoreboard success-rate identity rules for minted logical ids.
- Dropping `ship` from `REQUIRED_PUBLIC_ENTRYPOINTS`.
- Merging factory-gate pack PRs from recover paths.
- A new unique-operation CLI or store format.

## Decisions

### D1 — Injectable dual-root resolver; never candidate-worktree `runsDir`

Add an injectable `resolveUniqueOperationRunsRoots` on `FactoryGateOpts`. Production default returns the canonicalized pair:

1. Loop state-home `<resolveStateHome({ env })>/runs`.
2. Control-host generic `runsDir(resolveFactoryControlRoot({ repoDir, env, factoryControlDir }))` when that factory-control root is non-null.

Canonicalize with `path.resolve`. Drop empty strings. Deduplicate identical resolved paths. Pass that same pair as `approvedRoots` to `loadFollowableChildRun` so followable child event/handoff paths stay inside those roots.

Do **not** call `runsDir(opts.repoDir)` to invent a generic root. `opts.repoDir` is often the candidate worktree. Include `runsDir(opts.repoDir)` only when that resolved path already equals one of the two allowed roots.

Keep `uniqueOperationRunsRoot` as a test override that **replaces** the generic root, not the whole pair. Tests inject the resolver or inject generic + state-home paths. They never populate a candidate-worktree `.agent-pipeline/runs` and treat it as host evidence.

`uniqueOperationRunsRoots(..., hostOnly)` currently returns only state-home under in-flight ship. That is the live miss. In-flight ship and standalone factory-gate both scan the same two control-host roots. Neither scans the candidate worktree unless that path is one of those roots.

`defaultScoreBoundPackLoop` and CLI `pipeline factory-gate` both call `runFactoryGate` without a resolver today. Production prepare must resolve the generic store without a new CLI verb: pass `env` / `factoryControlDir` into `runFactoryGate` so the default resolver sees factory-control signals. Tests inject the resolver on `runFactoryGate` and on `defaultScoreBoundPackLoop` (extend `ScoreBoundPackLoopArgs` / `FactoryGateOpts`).

Alternative considered: copy host generic runs into the candidate worktree. Rejected: duplicates durable identity.

Alternative considered: replace state-home with the generic store. Rejected: pack loops still live in state-home; the issue requires **both**.

Alternative considered: fall back to `runsDir(opts.repoDir)` when factory-control env is unset. Rejected by plan review: that is the candidate worktree path.

### D2 — In-flight keep is missing-field only; infer in-flight only from `opts.inFlightShip`

Extend `filterAttemptsBoundToCandidate` with an explicit `inFlightShip` flag. When that flag is true:

- Keep attempts whose `candidate_sha` is missing/empty.
- Keep attempts whose release identity is missing/empty when the scored release identity is set.
- Drop attempts bound to a **different** candidate SHA.
- Drop attempts with a **present** mismatched release identity.

When the flag is false (standalone factory-gate), unbound and missing-release artifacts still drop. Other-candidate and mismatched-release still drop.

Set the flag only from `opts.inFlightShip === true`. `defaultScoreBoundPackLoop` is the production setter. Do **not** infer in-flight from `factory_release_binding`, manifest `in_flight_ship`, or compute-input flags. Those would copy the keep/inventory exceptions onto standalone `factory-gate --from-run`.

Alternative considered: stamp the current pack candidate SHA onto unbound runs. Rejected: #1428 already forbade stamping later provenance.

Alternative considered: keep unbound for every FRG score. Rejected: standalone factory-gate must stay fail-closed on unbound artifacts.

### D3 — Mapping precedence: recognized kind/entrypoint, then prefixes

Extend `attemptsFromRunArtifacts` (first holding rung; do not write a second mapper).

Entrypoint order:

1. `mapPublicEntrypoint(run_start.entrypoint)` when the value is a member of `REQUIRED_PUBLIC_ENTRYPOINTS`.
2. Else `mapPublicEntrypoint(run.json.kind)` when that value is a member.
3. Else a stable run-id prefix, checked in this order: `merge-queue-` / `mq-` → `merge-queue`; `train-` → `train`; `loop-` → `loop`; remaining `merge-` → `merge`; numeric drive `<issue>-<timestamp>` (`runIdFor`) → `drive`.

Unrecognized `kind` values such as `advance` are not members of `REQUIRED_PUBLIC_ENTRYPOINTS`. They MUST fall through to prefixes. They MUST NOT become `single`. If no prefix matches, entrypoint stays `null`.

Do not add a `ship-` prefix. Spec lists train/loop/merge/merge-queue/numeric-drive only. In-flight ship already defers missing `ship` coverage.

### D4 — Fallback-identity provenance: observe entrypoints, do not inflate SLOs

When no durable `logical_operation_id` exists and `run_id` is non-empty, set `logical_operation_id` to `run_id` and stamp `identity_provenance: "run_id_fallback"` on `UniqueOperationAttempt`. Minted ids stamp `identity_provenance: "minted"` (or omit, treated as minted).

`aggregateUniqueOperationReliability` SHALL treat `run_id_fallback` as entrypoint coverage observation:

- Group by that `run_id` so `entrypoint_coverage.observed` can include the mapped public entrypoint.
- Do not increment `missing_correlation` solely because a minted logical id is absent.
- Do not increment `ownerless_terminal` solely because `postcondition_proof` is absent.
- Do not count the attempt as verified unique-operation success (`clean_completion` numerator stays unchanged).
- Do not record it as a stable exclusion.

Scoreboard keeps using `attemptsFromRunArtifacts`. Provenance is what prevents fallback ids from inflating ownerless/missing-correlation there. Do not add a second mapper.

This is a physical-run fallback identity, not a new admission mint.

### D5 — Deduplicate the same durable run across the two roots

`collectUniqueOperationsFromRunStore` already skips `seen` directory names. Keep that. Scan the canonicalized roots in stable order: loop state-home first, then generic. The first occurrence of a run id wins. The same durable `run_id` MUST NOT produce two attempts or two executed-row copies.

### D6 — Candidate-tree inventory only; binder-accepted rows; no standalone mint

When `opts.inFlightShip === true` **and** host artifacts have no binder-accepted executed rows for the scored SHA:

- Load inventory through an injectable `loadCandidateFaultRecoveryInventory({ candidateSha, repoDir })`.
- Attach only when the loader returns `{ rows, sourceSha }` with `sourceSha === scored candidate SHA`.
- Run `assertFaultRecoveryInventoryComplete(rows)`. On throw / non-empty gaps, do not attach.
- Map applicable cells to `executed_matrix_rows` with `candidate_sha` equal to the scored SHA, `observed_terminal` equal to the cell's `expected_terminal`, and `passed: true`.
- Pass those rows through `bindExecutedMatrixRowsForCandidate`. Only binder-accepted rows feed `covered_lifecycle_classes`.

Do not stamp `passingUniqueOperationManifest().covered_lifecycle_classes`.

Do not attach when `sourceSha` is missing or differs from the scored SHA (host checkout at another SHA).

Standalone factory-gate (`opts.inFlightShip` unset/false) SHALL NOT mint inventory rows. Absence of durable executed rows there stays missing required coverage.

Tests inject complete inventory, incomplete inventory, helper-class stamps, and standalone separately. They do not use git or subprocess to prove SHA.

Production default: `defaultScoreBoundPackLoop` passes `request.integrated_candidate.git_sha` as `sourceSha` only for the candidate tree that prepare is scoring (`args.repoDir`). CLI `factory-gate` does not pass `inFlightShip` and must not attach.

This is not a second matrix runner. The inventory already declares covering cells; the binder already accepts executed rows that match those cells.

### D7 — Hard-gate text keeps SLO and binding diagnostics

`generateDurableUnsignedFrg` already appends `uniqueOperationSloFailure` and `uniqueOperationReleaseBindingFailure` (skipping a duplicate when the strings are equal). Keep both when both exist and they differ.

The prepare CLI path that falls back to `generated.message ?? "FRG structural eligibility failed for <ver>"` SHALL NOT emit that bare sentence when those diagnostics exist.

Tests:

- SLO diagnostic only → message includes SLO text.
- Binding diagnostic only → message includes binding text.
- Both exist → message includes both.
- None of those messages equal only `factory-release prepare: FRG structural eligibility failed for <version>. Hard gate: release preparation blocked.`

Do not reimplement SLO checks in prepare.

### D8 — Tests inject host run stores; no suite-pass claim until they exist

Hermetic tests MUST inject fs/run-store/resolver/inventory seams (no network, git, or subprocess). See tasks.md. Tester evidence does not exist yet. Do not claim `npm test` / `npm run ci` pass for this candidate until those commands are run after the code lands.

## Risks / Trade-offs

- **[Risk] `resolveFactoryControlRoot` is unset on a host that still has generic runs under a checkout.** → Mitigation: fail closed on a missing generic root rather than scanning `runsDir(opts.repoDir)`. Tests inject the generic root. Production ship on the control host supplies `AGENT_PIPELINE_FACTORY_CONTROL` / factory-plane `REPO_DIR`.
- **[Risk] Run-id fallback collapses retries into many unique operations.** → Mitigation: D4 provenance observes entrypoints and skips ownerless/missing-correlation/verified-success.
- **[Risk] Inventory-derived #1333 rows are mistaken for a helper stamp.** → Mitigation: rows must bind to declared cells through `bindExecutedMatrixRowsForCandidate`; helper stamps still fail; incomplete inventory and mismatched `sourceSha` fail closed.
- **[Risk] Host train stream still lacks followable `train_loop_linked`.** → Mitigation: this change does not invent #1301 linkage. Child paths that escape the two canonical roots stay unloaded (`pathInsideApprovedRunsRoot`).
- **[Risk] In-flight unbound-keep or inventory mint is copied onto standalone factory-gate.** → Mitigation: D2/D6 gated only on `opts.inFlightShip === true`. Tests fail if standalone keeps unbound artifacts or attaches inventory rows.
- **[Risk] Inferring in-flight from `factory_release_binding`.** → Mitigation: stop using that inference for collector exceptions. Binding still exists for SHA/release identity.

## Migration Plan

- No schema migration. Existing control-host generic runs become visible to in-flight ship FRG scoring.
- Unsigned `latest.json` with `pass: false` from the failed v1.40.1 pack remains fail until re-scored. Re-invoke `factory-release prepare` after this change; do not rewrite fail into pass.
- Tag/promote HMAC path unchanged.

## Open Questions

None. Dual-root resolver, missing-field in-flight keep, mapper precedence, fallback provenance, inventory SHA binding, and hard-gate text are decided.
