## 1. Types and manifest model

- [ ] 1.1 Add reconciliation types (action kinds, manifest identity, live-state fingerprint, progress/completed/pending) on the SemVer roadmap plan model in `core/scripts/roadmap/types.ts`
- [ ] 1.2 Define the reviewed reconciliation manifest shape: target milestones (stable identity when known, title, description, version_impact, issue set), ordered actions, fingerprint, optional progress
- [ ] 1.3 Extend writeback/apply `Deps` seams for list milestones (number, title, state, description, open-issue counts), create, reopen, rename, update description, get/set/clear issue milestone, and open-issue snapshot inputs for fingerprinting

## 2. Planner: target state and actions

- [ ] 2.1 Build the SemVer target assignment for every open issue from resolved #909 applied impact only; record coverage blockers for unresolved missing/conflict labels
- [ ] 2.2 Diff live milestone catalog + issue assignments against the target to produce ordered actions: create, reuse, reopen, rename, update_description, assign, clear_stale
- [ ] 2.3 Enforce identity rules: prefer milestone number; unique title only when unambiguous; fail visibly on title collisions without a stable identity
- [ ] 2.4 Classify closed milestones as shipped (immutable) vs closed empty unshipped planning (reopen only when named by the manifest)
- [ ] 2.5 Compute live-state fingerprint over open issues and relevant milestones; attach fingerprint + manifest identity to the plan/manifest artifacts

## 3. Dry-run preview surface

- [ ] 3.1 Default dry-run lists every planned action (create, reuse, reopen, rename, description update, assign, clear_stale) with milestone identity and issue numbers
- [ ] 3.2 Dry-run lists coverage blockers (unresolved classification / unmilestoned gaps) without mutating GitHub
- [ ] 3.3 Confirm theme/epic labels are never treated as satisfying the release-milestone invariant in planner or preview

## 4. Apply execution, drift gate, and resume

- [ ] 4.1 Gate `--apply` under SemVer on: no coverage blockers, exact reviewed manifest identity, and fresh fingerprint matching the preview fingerprint
- [ ] 4.2 Execute actions in order; persist progress (completed/pending, manifest identity, apply-start fingerprint) after each successful mutation
- [ ] 4.3 On partial failure, leave progress durable; resume with the same manifest identity skips completed creates/assigns and continues pending work
- [ ] 4.4 Abort apply/resume when fingerprint drift invalidates the pending plan; require a new preview
- [ ] 4.5 Ensure second apply against converged state reports no mutation (exact no-op)
- [ ] 4.6 Leave `release_model: continuous` on existing create/reuse/assign behavior (no SemVer full-recon contract)

## 5. Tests (injected GitHub seams)

- [ ] 5.1 Title collision: ambiguous same-title milestones without stable identity fail visibly
- [ ] 5.2 Stale assignment removal moves an issue from the wrong milestone to the manifest target
- [ ] 5.3 Issue-state drift between preview and apply refuses apply
- [ ] 5.4 Changed manifest identity is rejected at apply
- [ ] 5.5 Closed shipped milestones are not renamed, reopened, or description-rewritten
- [ ] 5.6 Named closed empty unshipped planning milestone can reopen and reuse; unnamed closed milestone is not reopened
- [ ] 5.7 Partial apply then retry resumes without duplicate milestones or repeated target assignments
- [ ] 5.8 Exact no-op convergence on second apply against converged state
- [ ] 5.9 Unresolved #909 classification blocks apply; prose does not select version
- [ ] 5.10 Theme-only labeling does not satisfy the milestoned invariant

## 6. Docs, mirror, and CI

- [ ] 6.1 Update generated/operator CLI and configuration docs for full SemVer reconciliation, dry-run action listing, fingerprint drift, and classification gate
- [ ] 6.2 Run `node scripts/build.mjs` and include regenerated `plugin/` when core changes require it
- [ ] 6.3 Run `npm run ci` and fix failures until green
