## 1. Canonical Diagnostics And Whole-Item Contract

- [x] 1.1 Implement and exhaustively test `pipeline/stage-diagnostic@1` construction, validation,
  evidence-key calculation, and projection for the closed provider-neutral reason-code set.
- [x] 1.2 Emit canonical diagnostics from every blocker path used by loop execution, preserving the
  exact structured blocker kind, stage/pre-merge class, and bounded reason needed for recovery.
- [x] 1.3 Extend `pipeline/loop-execution@1` responses with the canonical diagnostic and typed
  `blocked_recoverable`, `blocked_needs_human`, `capacity_wait`, and `coexistence_wait` outcomes;
  reject missing, malformed, or disposition-inconsistent diagnostics as protocol failures.
- [x] 1.4 Add cross-adapter contract fixtures proving equivalent Claude, Codex, Grok, and extension-
  adapter diagnostics project identically without provider-name branches.

## 2. Durable Recovery Primitives

- [x] 2.1 Make recovery start persist `outcome: "started"` and charge exactly one class-budget unit
  before side effects, keyed by item, candidate identity, evidence fingerprint, and action.
- [x] 2.2 Make recovery completion idempotently persist success or exact failure, resume the same
  item only on success, and leave failed/no-progress attempts charged across process restart.
- [x] 2.3 Reconcile an existing `started` attempt against current item, candidate, and diagnostic
  identity before replay or completion; reject stale attempts without mutating the new candidate.
- [x] 2.4 Add injected-dependency regression tests for failed-attempt charging, crash-after-start,
  duplicate start, exhausted budgets, stale candidate identity, and successful same-item resume.
- [x] 2.5 Persist `not_before`, defer recovery without starving siblings, reconcile exact pushed
  repair commits after crashes, expire stale authority, and supersede claims on fresh completion.

## 3. Production Supervisor Recovery

- [x] 3.1 Add a closed recovery-executor registry for the existing recipes, including
  `repair_pipeline_item`, with provider-neutral inputs and explicit success/error results.
- [x] 3.2 Wire canonical diagnostic projection and recovery selection into the production supervisor
  after dispatch and before any hold, `run_fatal`, recovery-exhausted, or other terminal mutation.
- [x] 3.3 Reconcile at cycle boundaries and observe fresh live issue/PR/candidate state after a
  blocked dispatch, immediately before and after a recovery side effect, and before persisting a
  remote-proving completion, human hold, or terminal stop.
- [x] 3.4 Preserve dependency-independent sibling progress while another item is recoverable or held,
  without weakening active-item, dependency, ownership-conflict, or merge-barrier invariants.
- [x] 3.5 Emit exactly one durable terminal event kind per driver exit: preserve
  `loop_run_stopped` for stop transitions, emit `loop_run_complete` for resolved/human-hold exits,
  and emit no terminal event on interruptible recovery.
- [x] 3.6 Add supervisor regression tests proving recovery executes before terminalization, a failed
  action consumes budget, restart resumes safely, siblings continue, and labels/prose never grant
  human authority.

## 4. Strict Human-Authority Boundary

- [x] 4.1 Restrict needs-human hold creation and `human_intervention` emission to a current valid
  `human-decision-required` diagnostic; route missing/unknown diagnostics to protocol failure.
- [x] 4.2 Remove label-only, outcome-name-only, stale-comment, capacity-only, format-error, and
  exhausted-mechanical paths to human holds while preserving a genuine human-decision hold.
- [x] 4.3 Update reconciliation next-action tests so `hold-for-human` requires current canonical
  human-decision evidence and contradictory or missing evidence remains engine-owned.

## 5. Shared Mechanical Remediation

- [x] 5.1 Implement a shared bounded remediation transaction that receives the exact diagnostic,
  resolves the configured implementer/model/effort, and constrains the repair to current item state.
- [x] 5.2 Reconcile and safely rematerialize/synchronize the managed worktree before implementer work,
  then validate, commit with required trailers, and push a successful repair through existing seams.
- [x] 5.3 Return exact typed failure/no-op evidence, refuse unsafe or stale partial work, and prohibit
  merge, deploy, release, credential, override, or review-policy authority in every executor path.
- [x] 5.4 Re-enter normal whole-item execution after a repair so candidate-changing work invalidates
  stale evidence and re-runs review, CI, OpenSpec, pre-merge, and readiness gates.

## 6. OpenSpec And Pre-Merge Integration

- [x] 6.1 Surface draft/post-revision `openspec validate` failures as canonical
  `implementation-ci`/`openspec-invalid` diagnostics with exact bounded CLI evidence.
- [x] 6.2 Route post-revision validation diagnostics through the outer shared bounded remediation
  transaction, then redispatch and re-run the same validation hook against the current candidate.
- [x] 6.3 Run archive in machine-readable mode, verify explicit per-change success plus active-
  directory removal, and route exact archive diagnostics through bounded remediation before
  exhaustion.
- [x] 6.4 Key pre-merge implementer repair to authoritative item/candidate/evidence/action identity;
  keep candidate checks, rematerialization, synchronization, and clean-tree checks outside that
  implementer attempt budget.
- [x] 6.5 Add regression tests for validation repair, archive conflict/output parsing, false archive
  success with an active directory left behind, charged remediation/no-op failure, and candidate
  movement before repair.

## 7. Generated Artifacts And Verification

- [x] 7.1 Update the OpenSpec delta specs affected by the additive diagnostic, loop response,
  recovery evidence, and strict human-authority contracts without adding provider-specific policy.
- [x] 7.2 Run focused core tests for diagnostics, loop execution, recovery, supervisor,
  reconciliation, planning, OpenSpec, and pre-merge behavior; fix every regression without lowering
  review or gate policy.
- [x] 7.3 Run `node scripts/build.mjs` after all `core/` edits and include the regenerated `plugin/`
  mirror in the same implementation commit.
- [x] 7.4 Run `openspec validate autonomous-recovery-controller --strict` and the full
  `npm run ci` gate, retaining command output as completion evidence.

## 8. Deterministic Recovery And Single-Issue Integration

- [x] 8.1 Order workflow-state, implementation-CI, and workflow-engine recipes so deterministic
  redispatch/re-entry executes before `repair_pipeline_item`, with regression coverage for fallback.
- [x] 8.2 Replace placeholder reauthentication with a live authenticated-actor verification that
  cannot enter credentials or clear state after a failed probe.
- [x] 8.3 Add a canonical one-item command that resumes active durable state, supersedes terminal
  state, emits early handoff, and uses the same supervisor as multi-item loops.
- [x] 8.4 Update Claude/Codex host skills and operator documentation to launch and observe the
  one-item controller, including the recovery-versus-human-authority matrix.
- [x] 8.5 Emit successful `loop_run_complete` records through the shared material-event filter and
  add regression coverage.
