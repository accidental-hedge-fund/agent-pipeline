## 1. Types and manifest model

- [x] 1.1 Add reconciliation types (action kinds, manifest identity, live-state fingerprint, progress/completed/pending) on the SemVer roadmap plan model in `core/scripts/roadmap/types.ts`
- [x] 1.2 Define the reviewed reconciliation manifest shape: target milestones (stable identity when known, title, description, version_impact, issue set), ordered actions, fingerprint, optional progress
- [x] 1.3 Extend writeback/apply `Deps` seams for list milestones (number, title, state, description, open-issue counts), create, reopen, rename, update description, get/set/clear issue milestone, and open-issue snapshot inputs for fingerprinting

## 2. Planner: target state and actions

- [x] 2.1 Build the SemVer target assignment for every open issue from resolved #909 applied impact only; record coverage blockers for unresolved missing/conflict labels
- [x] 2.2 Diff live milestone catalog + issue assignments against the target to produce ordered actions: create, reuse, reopen, rename, update_description, assign, clear_stale
- [x] 2.3 Enforce identity rules: prefer milestone number; unique title only when unambiguous; fail visibly on title collisions without a stable identity
- [x] 2.4 Classify closed milestones as shipped (immutable) vs closed empty unshipped planning (reopen only when named by the manifest)
- [x] 2.5 Compute live-state fingerprint over open issues and relevant milestones; attach fingerprint + manifest identity to the plan/manifest artifacts

## 3. Dry-run preview surface

- [x] 3.1 Default dry-run lists every planned action (create, reuse, reopen, rename, description update, assign, clear_stale) with milestone identity and issue numbers
- [x] 3.2 Dry-run lists coverage blockers (unresolved classification / unmilestoned gaps) without mutating GitHub
- [x] 3.3 Confirm theme/epic labels are never treated as satisfying the release-milestone invariant in planner or preview

## 4. Apply execution, drift gate, and resume

- [x] 4.1 Gate `--apply` under SemVer on: no coverage blockers, exact reviewed manifest identity, and fresh fingerprint matching the preview fingerprint
- [x] 4.2 Execute actions in order; persist progress (completed/pending, manifest identity, apply-start fingerprint) after each successful mutation
- [x] 4.3 On partial failure, leave progress durable; resume with the same manifest identity skips completed creates/assigns and continues pending work
- [x] 4.4 Abort apply/resume when fingerprint drift invalidates the pending plan; require a new preview
- [x] 4.5 Ensure second apply against converged state reports no mutation (exact no-op)
- [x] 4.6 Leave `release_model: continuous` on existing create/reuse/assign behavior (no SemVer full-recon contract)

## 5. Tests (injected GitHub seams)

- [x] 5.1 Title collision: ambiguous same-title milestones without stable identity fail visibly
- [x] 5.2 Stale assignment removal moves an issue from the wrong milestone to the manifest target
- [x] 5.3 Issue-state drift between preview and apply refuses apply
- [x] 5.4 Changed manifest identity is rejected at apply
- [x] 5.5 Closed shipped milestones are not renamed, reopened, or description-rewritten
- [x] 5.6 Named closed empty unshipped planning milestone can reopen and reuse; unnamed closed milestone is not reopened
- [x] 5.7 Partial apply then retry resumes without duplicate milestones or repeated target assignments
- [x] 5.8 Exact no-op convergence on second apply against converged state
- [x] 5.9 Unresolved #909 classification blocks apply; prose does not select version
- [x] 5.10 Theme-only labeling does not satisfy the milestoned invariant

## 6. Docs, mirror, and CI

- [x] 6.1 Update generated/operator CLI and configuration docs for full SemVer reconciliation, dry-run action listing, fingerprint drift, and classification gate
- [x] 6.2 Run `node scripts/build.mjs` and include regenerated `plugin/` when core changes require it
- [x] 6.3 Run `npm run ci` and fix failures until green
