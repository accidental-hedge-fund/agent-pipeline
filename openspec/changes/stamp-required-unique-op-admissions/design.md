## Context

See `proposal.md` for motivation and the delta specs for normative behavior.

The first reusable holding rung already exists. `persistPublicEntrypointAdmission` resolves the control-host generic root and writes through `initRunDir`; direct `pipeline single`, `pipeline merge`, and `pipeline merge-queue` already call it. `initRunDir`, however, intentionally catches initialization errors as non-fatal telemetry behavior, and the public helper currently returns a path without proving that `run.json` and its `run_start` record were persisted with the requested identity. The direct call sites therefore cannot treat return as a durable admission acknowledgment.

Train has a separate outer generic-run session with a `logicalOperationId`, but production `mergeIssuePr` calls the shared merge surface without recording a distinct nested `merge` admission. The collector already recognizes `run.json.kind`, `run_start.entrypoint`, and `single-*`, `merge-*`, `merge-queue-*` / `mq-*` prefixes. `REQUIRED_PUBLIC_ENTRYPOINTS` already contains `drive`, `single`, `loop`, `train`, `merge`, `merge-queue`, and `ship`, but that list has no machine-checked correspondence to admission producers.

Existing constraints remain in force:

- The generic run store and its injected I/O seam remain the persistence surface; no second store is introduced.
- General run-store events and train-stream observability retain their existing best-effort rules. Admission acknowledgment for a protected operation is a narrower, stricter contract.
- RecoverySupervisor remains the lifecycle owner. Advance and loop never merge, and no record grants merge or release authority.

## Goals / Non-Goals

**Goals:**

- Turn the existing public-admission helper into the one acknowledged admission path used by direct `single`, `merge`, `merge-queue`, and train-nested `merge` work.
- Preserve one root Logical Operation across outer train and nested merge records while retaining both entrypoint identities.
- Make a missing required-entrypoint admission producer a deterministic CI failure.
- Keep collection artifact-driven and fail-closed.

**Non-Goals:**

- Replacing the generic run store, collector, mapper, merge invariant, or RecoverySupervisor.
- Making all best-effort telemetry writes control-critical.
- Treating admission as postcondition proof, replay authority, merge authority, or release authority.
- Backfilling historical coverage by replaying or fabricating commands.
- Adding a public verb, per-verb markdown pack, host engine, or scheduler.

## Decisions

### D1 — Strengthen the existing public-admission helper with an acknowledged persistence result

Keep `persistPublicEntrypointAdmission` as the shared admission contract and keep the artifact in the existing control-host generic run-store layout. The contract receives the public entrypoint and an optional admitted root `logical_operation_id`. It creates a distinct physical run id, persists matching kind/start identity plus the root Logical Operation, and returns success only after the persisted identity can be read back and validated.

The strict acknowledgment is scoped to this helper. The general `initRunDir` and `appendEvent` behavior remains compatible with existing best-effort telemetry consumers. The helper must convert swallowed initialization or event-write failure, malformed read-back, and mismatched kind/entrypoint/logical identity into one typed admission-persistence failure. Production durability uses the repository's existing atomic-publication and flush/read-back patterns rather than an in-memory success flag. Tests use the existing injected run-store seam.

No secret, credential, authority grant, candidate authorization, or command arguments beyond existing sanitized run metadata are added to the artifact.

Alternative considered: make every `initRunDir` caller fail on any write error. Rejected because it changes the established best-effort telemetry contract far beyond protected unique-operation admission.

Alternative considered: add a unique-operation-only ledger or marker directory. Rejected because the generic run artifact already carries the identity the collector consumes.

### D2 — Route all four missing admission sites through the shared contract before their boundary

Direct `single`, `merge`, and `merge-queue` continue to use the existing helper, but their call sites consume the acknowledged result. `single` admits before launching its supervised drive. Direct `merge` admits before invoking the merge adapter. `merge-queue` admits after argument/config validation but before dry-run execution or apply-mode protected work; apply mode can never reach merge or repair side effects after a failed stamp.

Train production dependencies gain an injected admission seam alongside the existing merge seam. Before each `mergeIssuePr` invocation, train writes a distinct `merge-*` artifact through the shared helper and supplies the outer train session's `logicalOperationId`. The physical record remains `merge`; its root identity remains the train admission. The existing outer `train` record is not rewritten, and the merge call continues to use the existing merge supervision and exact-candidate gates.

When the shared contract reports failure, the caller emits the existing typed mechanical observation and returns control to RecoverySupervisor. Command and train code do not add a local retry policy and do not project `pipeline:needs-human` without independent typed-request evidence.

Alternative considered: infer nested merge coverage from `train_merge_attempted` or `train_merge_proven`. Rejected because those events do not prove that a public-entrypoint admission record was durably established before the mutation boundary.

Alternative considered: give every nested merge a new Logical Operation. Rejected because nested train work must remain in the admitted root denominator; the distinct `run_id` already preserves attempt identity.

### D3 — Make admission inventory and required coverage mechanically correspond

Add one shared inventory adjacent to the required-entrypoint contract. Each `REQUIRED_PUBLIC_ENTRYPOINTS` member names its canonical durable admission producer. The entries for `single`, `merge`, and `merge-queue` route through the acknowledged public-admission contract; the `merge` entry also declares the train-nested admission site. Existing producers for `drive`, `loop`, `train`, and `ship` remain represented by their current durable admission paths.

CI performs a set-equality check between required entrypoints and inventory keys, rejects duplicate or unknown entries, and runs hermetic producer tests so adding a name-only inventory row cannot satisfy the gate. Call-site tests assert that direct merge and merge-queue cross the admission seam before their protected adapters and that train passes the outer Logical Operation to its nested merge stamp.

Alternative considered: scan source text for helper names. Rejected because source-shape regexes can pass while runtime routing bypasses the contract. The injected admission seams provide behavioral evidence.

Alternative considered: derive required coverage exclusively from the inventory. Rejected because keeping the SLO list and admission inventory independently comparable makes omission visible rather than self-consistent by construction.

### D4 — Keep collection evidence-only and separate admission from completion

Retain the existing collector and mapper. A stamped artifact may add its mapped entrypoint to `entrypoint_coverage.observed`. Multiple physical artifacts with the same `logical_operation_id`, such as outer `train` and nested `merge`, contribute both entrypoint identities to the same aggregated Logical Operation. They do not add a second success.

No collector rule maps numeric drive to `single`, and raw train merge events do not become `merge` coverage without the qualifying nested artifact. Missing artifacts remain in `entrypoint_coverage.missing`. Existing postcondition evidence remains necessary for verified completion.

Alternative considered: synthesize the three missing rows from command availability, train events, or the inventory. Rejected because availability and declarative registration are not evidence that an attempt was admitted.

### D5 — Preserve the prepare hard gate and generated surfaces

Keep `uniqueOperationSloFailure` in the release-prepare structural eligibility path. Stamp persistence failure is not a reason to demote missing coverage or request human attestation. No public command documentation is added. If shared inventory or generated FRG documentation has a generator-owned representation, regenerate it through the existing generator and keep its check mode green.

## Risks / Trade-offs

- **[Risk] The strict admission acknowledgment conflicts with best-effort run-store behavior.** → Limit strictness to the shared protected-admission wrapper; leave general telemetry and train event append policy unchanged.
- **[Risk] A train merge stamp and outer train record appear to be two successes.** → Reuse the root `logical_operation_id`; aggregation retains two entrypoints but one Logical Operation, and admission alone never supplies verified completion.
- **[Risk] A declarative inventory row masks a missing runtime call.** → Pair set correspondence with injected-seam behavioral tests at every declared admission site.
- **[Risk] Persisting before gates creates artifacts for attempts that never submit a merge.** → This is intended: the record proves admission, not successful mutation. Completion still requires authoritative postcondition proof.
- **[Risk] The control-host root is unavailable or unwritable.** → Fail before protected work and report mechanical lifecycle evidence. Do not fall back to a candidate-worktree artifact and claim coverage.
- **[Risk] Existing failed FRG evidence remains failed after deployment.** → Keep historical evidence immutable; only later real admissions and a new score may satisfy coverage.

## Migration Plan

1. Ship the shared acknowledged admission contract, inventory, and four admission-site integrations with hermetic regression tests.
2. Regenerate host and FRG/unique-operation documentation only through existing generators when their sources change.
3. Run the full repository CI gate before integration.
4. Re-run the ordinary authorized ship/FRG flow. Do not replay or fabricate merge, merge-queue, or single solely to populate coverage.
5. Rollback is a code rollback only; existing additive run artifacts remain readable and do not grant authority or assert completion.

## Open Questions

None. The shared store, strict boundary, identity propagation, inventory correspondence, artifact-only collection, and hard-gate behavior are fixed by the issue contract.
