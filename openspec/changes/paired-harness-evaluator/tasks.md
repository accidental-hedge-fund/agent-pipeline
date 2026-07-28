## 1. Contract and planning

- [x] 1.1 Extend eval types and manifest validation for additive named treatments and `paired` mode, with stable pair-aware treatment/cell ids.
- [x] 1.2 Add manifest and expansion tests covering valid named pairs, preserved Cartesian manifests, invalid mixed forms, duplicate ids, and missing paired coordinates.
- [x] 1.3 Add a paired fixture contract/example using an implementing artifact and deterministic final checks.

## 2. Paired execution

- [x] 2.1 Materialize primary implementation, dynamic-diff reviewer, primary-fix, and re-review prompts using the existing verdict schema.
- [x] 2.2 Execute the paired trajectory in the existing isolated worktree/deadline/refusal path and record phase provenance, findings, diffs, and convergence.
- [x] 2.3 Add unit tests for diff handoff, fix/no-fix branches, malformed review output, shared timeout, preflight, no GitHub writes, and cleanup.

## 3. Grading and reporting

- [x] 3.1 Grade paired cells from their final implementation state and record convergence additively.
- [x] 3.2 Extend comparative reporting with ordered pair identity and convergence metrics.
- [x] 3.3 Add deterministic grading/reporting tests proving pair direction remains distinct and independent-review accuracy is never fabricated.

## 4. Documentation and verification

- [x] 4.1 Document named treatments and paired mode in host-facing evaluation guidance.
- [x] 4.2 Run OpenSpec validation, focused tests, plugin regeneration/check, and full `npm run ci`.
- [x] 4.3 Create plan-only and bounded live-evaluation manifests for Claude→Codex baseline and Codex/Grok candidate pairs; run, grade, report, and write the evidence-backed recommendation.

## 5. Deployable full-pipeline policy evaluation

- [x] 5.1 Add `pipeline-paired` named-treatment validation with a complete YAML-shaped models/effort policy.
- [x] 5.2 Execute dynamic planning → plan-review → revision → implementation → review-1/fix-1/review-2/fix-2 handoffs and capture policy provenance.
- [x] 5.3 Grade/report final implementation state and carry the deployable policy into pair convergence output.
- [x] 5.4 Add unit tests for policy coupling, live plan/diff handoffs, and invalid policy shapes; synchronize the plugin mirror and run core tests.
- [x] 5.5 Run the bounded four-direction dynamic smoke, then construct and execute the approved screened corpus. (Smoke: `pipeline-routing-smoke-20260728c`; primary screen: 90 cells; reviewer screens: 60 cells; final/recovery validation: 165 cells.)

## 6. Production-contract reconciliation

- [x] 6.1 Replace simplified pipeline-paired prompts with all eight pure production prompt builders plus an evaluation-only execution override for implementation/fix.
- [x] 6.2 Enforce production planning/plan-review/revision gates, standard/adversarial review roles, review-1 context handoff, and review-policy partitioning.
- [x] 6.3 Keep the eval contract active during reviewers while excluding evaluator-owned files from diffs and checks.
- [x] 6.4 Distinguish review-2/pre-fix-2 evidence from the post-fix-2 final diff; report verdict parse provenance and resolved named-treatment grouping.
- [x] 6.5 Permit required generated plugin mirrors in fixture path boundaries and document the freeform-planning/OpenSpec limitation.
