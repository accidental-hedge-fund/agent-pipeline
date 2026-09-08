## Context

See `proposal.md` for motivation and the delta specs for required behavior. The change crosses four established boundaries but does not require a new subsystem:

- `grill-decisions.ts` already owns canonical Decisions serialization, rendering, parsing, integrity checks, and the supported issue-body ceiling.
- `runPlanningPhases` already owns revision acknowledgement and implementation dispatch; `makeOpenspecPlanningHooks` already owns change identity, structural validation, and artifact reads.
- `realDispatchItem` already has injected child-event and forge observers and returns a structured stage diagnostic plus a linked run evidence pointer.
- RecoverySupervisor already retains linked advance identity, injects `readAdvanceEvents`, classifies diagnostic-specific recipe applicability, and persists per-strategy Recovery Episode attempts. The legacy class budget is only a compatibility projection at the write-ahead claim boundary.

The branch already contains the bounded admission repair candidate from the reproduced grill failure. Implementation must preserve and review that candidate rather than reconstructing it from the integration base.

### Class vs site

- The sites were grill admission for #1563/#1560/#1564 and planning/recovery for #1558.
- The classes are repeated semantic values expanded at every render site, refinement acknowledgement detached from authoritative artifact application, diagnostic observation performed after a fallible independent refresh, and an outer admission gate using a weaker legacy budget than the strategy selector.
- The shared renderer/parser, OpenSpec planning hooks, dispatch evidence boundary, linked-run observation seam, and Recovery Episode gates are the class-level repair surfaces. The next equivalent failure must use these same contracts without an issue-specific path.

## Goals / Non-Goals

**Goals:**

- Keep one canonical semantic Decisions model while allowing a compact wire representation.
- Make OpenSpec artifact application, validation, reread, and implementation-input construction one coherent handoff.
- Preserve the most precise valid observation and represent independent uncertainty without turning it into success.
- Align outer recovery admission with existing diagnostic-specific, per-strategy Recovery Episode authority.
- Replay the captured failures with deterministic injected I/O at their real caller boundaries.

**Non-Goals:**

- A Decisions schema-version bump, lossy compression, or reduced authority/hash validation.
- Treating arbitrary revision stdout as the authoritative OpenSpec change or adding a second planning store.
- A second recovery classifier, recoverer, scheduler, or controller.
- Editing retained historical logs or ledgers, refunding attempts, creating a new episode for the same identity, or synthesizing Tester success.
- New FRG fixtures, release orchestration, public configuration, versioning, publication, deployment, or merge behavior.

## Decisions

### 1. Use an additive evidence catalog in the existing Decisions wire format

The in-memory `DecisionsArtifact` remains fully expanded. Canonical serialization computes repeated evidence by exact string identity, stores beneficial repeated values in one digest-keyed catalog, and replaces their occurrences in node and authority-request evidence with digest references. Parsing validates each catalog key against its value before expanding references back into the existing semantic shape. The readable Decisions section renders repeated evidence as the shared digest reference, avoiding a second expansion.

Compaction is used only when it reduces the complete body. The existing schema marker remains `decisions.v1` because inline artifacts remain valid and the catalog is an additive wire representation that expands to the same semantic object. The body-size guard remains at `embedDecisionsInBody`, after the full core, marker, fence, and readable section are assembled and before any caller can publish.

Alternatives considered:

- Truncate evidence or omit it from authority requests: rejected because it loses unique authority evidence and breaks semantic/hash guarantees.
- Compress or externalize the artifact: rejected because the issue body is the specification and existing deterministic parsing must remain sufficient.
- Increment the schema and migrate old bodies: rejected because additive parse compatibility provides the required round-trip without migration.

### 2. Make OpenSpec revalidation prove application, then reread one artifact snapshot

Revision acknowledgement continues through `plan-revision.ack@1`; it proves output shape only. The OpenSpec hook then compares the authoritative change after the revision with its pre-revision artifact state and the accepted refinement. Success requires a material, coherent application to the identified change plus structural validation. The hook returns the reread proposal and spec context from that validated state. `buildImplPlan` rereads the corresponding tasks from the same change and builds implementation input only from authoritative files.

The existing `changeId` restoration, worktree-scoped revision invocation, scoped OpenSpec salvage, and structural validation seams are reused. An unchanged artifact cannot use stdout fallback. A missing proposal, an acknowledged no-op, a mismatch between accepted refinement and artifact, or invalid deltas returns an explicit engine-owned OpenSpec failure before implementation. The freeform hook retains its current stdout-based behavior.

Alternatives considered:

- Prefer revision stdout when proposal files are unchanged: rejected because stdout is not the OpenSpec artifact and caused the reproduced silent fallback.
- Write stdout directly into `proposal.md`: rejected because a refinement can require coordinated proposal, tasks, design, and delta changes; automatic single-file replacement can create incoherence.
- Add a parallel refinement ledger: rejected because the worktree change directory and existing validation are already authoritative.

### 3. Classify child evidence before the fallible forge refresh

After the child settles and its run store is confirmed, `realDispatchItem` reads and validates the linked child events before calling forge observers. The child diagnostic is retained independently from issue/PR refresh results. Forge observations still determine forge facts and outcome projection when available; an exception contributes an uncertainty observation but cannot erase a valid child diagnostic. Process-termination diagnostics remain the fallback only when no more precise valid child diagnostic exists.

The response continues to carry the existing structured diagnostic and evidence pointer. If representing the forge uncertainty requires an additive diagnostic detail field, that field records only observation failure; it is never a gate pass, candidate proof, or Tester subject.

Alternatives considered:

- Catch the forge exception and return only a generic loop-supervisor failure: rejected because it discards the stronger completed-child evidence.
- Treat the child blocker as proof that forge state is unchanged: rejected because the forge is independently unobservable.
- Retry or synthesize forge facts inside dispatch: rejected because this issue does not change observation authority or add a retry controller.

### 4. Refine coarse retained evidence through the existing linked-event seam

Before selecting a blocked recovery recipe, RecoverySupervisor may reread the linked advance's terminal events when persisted recovery evidence is coarse. It reuses `SupervisorDeps.readAdvanceEvents`; no second event reader or recovery controller is added. The read is authorized only when the blocked record's transport run ID matches the retained `advance_run_id`, and the event location resolves to that run's canonical run-store `events.jsonl`. Parsed terminal evidence must name the same item and satisfy the existing structured diagnostic validator.

A valid more-precise diagnostic replaces only the diagnostic used for current classification and recipe applicability. The ledger history, attempts, class-budget projection, evidence/candidate episode key, and source events stay unchanged. Missing, malformed, mismatched, or non-canonical observations leave the coarse persisted evidence in force and fail closed.

Alternatives considered:

- Repair the captured ledger manually: rejected because it does not protect future runs and violates historical-state constraints.
- Accept the persisted event path without checking run identity/location: rejected because an arbitrary file could confer diagnostic authority.
- Mint a new Recovery Episode for the refined diagnostic: rejected because the same operation, candidate, and retained linked run are being observed; prior attempt bounds must remain authoritative.

### 5. Share per-strategy eligibility logic between outer admission and selection

Extract or reuse a pure eligibility predicate built from the current Recovery Episode: lifecycle/Cooling status, policy order, diagnostic-specific applicability, strategy cursor, attempts per strategy, and per-strategy bounds. Both `independentlyRecoverableBlockedItems` and execution-time strategy selection use that contract. The class-level `recovery_budgets_remaining` field remains updated for compatibility but is not an admission veto.

The predicate reports eligible if at least one applicable configured strategy has remaining bound. It reports bounded ineligible when every applicable strategy is exhausted, and it does not turn inapplicable recipes into candidates. Dependency filtering and compatibility-stop scoping remain separate scheduling constraints, so an ineligible item does not suppress independent siblings.

Alternatives considered:

- Raise or reset the legacy class budget: rejected because it refunds historical attempts and conflicts with per-strategy episode authority.
- Remove all outer eligibility checks: rejected because exhausted episodes still need finite Cooling and dependency/lifecycle gates.
- Special-case `rebind_tester_evidence_after_pr`: rejected because every later strategy must obey the same shared contract.

### 6. Test the real boundaries with injected I/O

Regression tests exercise `embedDecisionsInBody`/parser, `makeOpenspecPlanningHooks` through implementation-plan construction, `realDispatchItem`, and RecoverySupervisor/outer eligibility using existing dependency seams. The retained recovery reproduction seeds coarse evidence, two spent scratch attempts, zero legacy class projection, and matching linked terminal events; it must select the unspent Tester-rebind recipe without changing episode history. Negative cases cover unmatched event identity, malformed streams, invalid/no-op refinements, unique oversize bodies, exhausted strategies, and independent siblings.

Baseline-failure evidence should be retained in test names or commit history where practical; production tests themselves assert repaired behavior. No unit test uses live GitHub, git, child processes, or filesystem state outside injected seams.

## Risks / Trade-offs

- **[Risk] Digest references could hide a collision or malformed catalog.** → Recompute every digest during parse, reject collisions/unresolved references, and compare the readable render with the expanded artifact.
- **[Risk] No-op detection could reject a valid wording-only acknowledgement.** → Require a material refinement only after the reviewer requested revision; bind the check to the accepted review/refinement contract rather than any stdout difference.
- **[Risk] Artifact files could change between validation and implementation-plan reads.** → Reread and build from one worktree/change identity immediately after validation; fail if identity or required files are missing rather than falling back.
- **[Risk] A stale or unrelated event stream could steer recovery.** → Bind run ID, item, canonical path, and structured terminal diagnostic; otherwise retain coarse evidence.
- **[Risk] Removing the class-budget veto could unbound recovery.** → Per-strategy bounds, strategy cursor, repeated-evidence limit, Cooling, and episode identity remain mandatory.

## Migration Plan

No external data or configuration migration is required. Existing inline Decisions bodies remain parseable. Existing Recovery Episodes retain their identities and attempts; eligible later strategies become reachable on the next supervised cycle after trusted linked-event observation. After core implementation, regenerate host artifacts and run the full repository CI gate. Rollback is a source revert; no historical run, issue body, or ledger is rewritten as part of deployment.
