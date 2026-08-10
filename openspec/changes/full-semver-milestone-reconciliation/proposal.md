## Why

`pipeline roadmap --apply` can create or reuse selected milestones and assign
listed issues, but it cannot converge the full open backlog to one reviewed
SemVer plan. It does not safely rename or reopen reusable milestones, update
descriptions, remove stale assignments, detect live-state drift after preview,
or prove that every open issue has exactly one release milestone. Operators need
a dry-run-first full reconciliation so applied GitHub state matches one reviewed
manifest without rewriting shipped history.

## What Changes

- Add a **full SemVer milestone reconciliation** path for
  `release_model: semver` (and default/absent): dry-run first, then apply only
  from an exact reviewed manifest against a fresh live-state fingerprint.
- The reviewed manifest is the sole target state for open-issue release
  milestones. After successful apply, **every open issue in the manifest has
  exactly one full SemVer milestone**, and **no open issue remains unmilestoned**.
- Reconciliation actions expand beyond create/assign-by-title: create missing
  milestones, reuse approved milestone identities, reopen reusable closed empty
  unshipped planning milestones when the manifest names them, rename where
  identity-safe, update descriptions, assign target issues, and **remove stale
  assignments**.
- Dry-run (preview) lists **every** planned action before mutation: milestone
  create, reuse, reopen, rename, description update, issue assignment, and stale
  assignment removal.
- Apply uses the **exact** reviewed manifest plus a **fresh** live-state
  fingerprint. Drift after preview stops apply or requires a new preview.
- Closed **shipped** milestones remain unchanged. Closed empty unshipped
  planning milestones may be reused only when the reviewed manifest names their
  identity.
- Theme / epic labels remain secondary ownership and search metadata; they
  **never** satisfy the release-milestone invariant.
- Compatibility impact for version selection continues to come only from the
  explicit structured classification owned by #909 (`semver:*` labels). Free-form
  issue prose does not select a version.
- Apply is **idempotent**: a second run against already-converged state reports
  no mutation.
- Partial failure records completed and pending actions and supports a **safe
  resume** without duplicate milestones or repeated assignments.
- Continuous release model remains outside this SemVer full-reconciliation
  contract (existing continuous grouping and apply semantics stay separate).

## Acceptance Criteria

- [ ] Every open issue in the reviewed manifest has exactly one full SemVer
      milestone after successful apply. No open issue remains unmilestoned.
- [ ] Compatibility impact for version selection comes only from the explicit
      structured classification owned by #909; free-form issue prose does not
      select a version.
- [ ] Dry-run output lists every milestone create, reuse, reopen, rename,
      description update, issue assignment, and stale assignment removal before
      any mutation.
- [ ] Apply uses the exact reviewed manifest and a fresh live-state fingerprint;
      drift after preview stops apply or requires a new preview.
- [ ] Reconciliation creates missing milestones, reuses approved milestone
      identities, updates descriptions, assigns target issues, and removes stale
      assignments.
- [ ] Closed shipped milestones remain unchanged; a closed empty unshipped
      planning milestone can be reused only when the reviewed manifest names its
      identity.
- [ ] Theme labels remain secondary metadata and never satisfy the
      release-milestone invariant.
- [ ] Apply is idempotent: a second run against converged state reports no
      mutation.
- [ ] Partial failure records completed and pending actions and supports a safe
      resume without duplicate milestones or repeated assignments.
- [ ] Tests cover title collisions, stale assignments, issue-state drift, changed
      manifest identity, closed shipped milestones, reusable unshipped milestones,
      partial apply, retry, and exact no-op convergence with injected GitHub seams.
- [ ] Generated CLI and configuration documentation and the `plugin/` mirror
      remain current; `npm run ci` passes.

## Capabilities

### New Capabilities

- _(none)_

### Modified Capabilities

- `roadmap-release-model`: Expand SemVer `--apply` from create/reuse-by-title +
  assign-only into full dry-run-first milestone reconciliation against a reviewed
  manifest (fingerprint drift gate, rename/reopen/description/stale-removal,
  full open-issue coverage invariant, shipped-milestone protection, idempotence,
  and partial-failure resume). Keep continuous model outside this contract.
  Preserve #909 label-only applied impact authority for version selection.

## Impact

- `core/scripts/roadmap/writeback.ts` — `applyMilestones` and dry-run preview
  expand to full reconciliation action plans (create/reuse/reopen/rename/
  description/assign/clear-stale), fingerprint check, and resume state.
- `core/scripts/roadmap/index.ts` — SemVer plan build and apply orchestration
  produce a reconciliation manifest covering all open issues eligible under the
  #909 classification contract; continuous path unchanged.
- `core/scripts/roadmap/types.ts` — reconciliation action / manifest / fingerprint
  / progress types on the plan model.
- `core/scripts/roadmap/inventory.ts` (or peer) — live-state fingerprint inputs
  for open issues and milestones used at preview and apply.
- `core/scripts/gh.ts` (or existing milestone helpers) — seams for reopen, rename,
  description update, clear milestone assignment, and richer milestone reads as
  needed for injected tests.
- `core/test/` — injected-seam coverage for collision, stale clear, drift, shipped
  protection, reopen reuse, partial apply/retry, and no-op convergence.
- Living OpenSpec `roadmap-release-model` requirements for apply and SemVer lanes.
- Generated CLI/config docs and `plugin/` mirror after core changes.
- No merge authority change; no milestone deletion; no shipped-history rewrite;
  no prose-based SemVer impact; continuous grouping remains separate.
