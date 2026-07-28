## 1. Contract and planning

- [ ] 1.1 Extend eval types and manifest validation for additive named treatments and `paired` mode, with stable pair-aware treatment/cell ids.
- [ ] 1.2 Add manifest and expansion tests covering valid named pairs, preserved Cartesian manifests, invalid mixed forms, duplicate ids, and missing paired coordinates.
- [ ] 1.3 Add a paired fixture contract/example using an implementing artifact and deterministic final checks.

## 2. Paired execution

- [ ] 2.1 Materialize primary implementation, dynamic-diff reviewer, primary-fix, and re-review prompts using the existing verdict schema.
- [ ] 2.2 Execute the paired trajectory in the existing isolated worktree/deadline/refusal path and record phase provenance, findings, diffs, and convergence.
- [ ] 2.3 Add unit tests for diff handoff, fix/no-fix branches, malformed review output, shared timeout, preflight, no GitHub writes, and cleanup.

## 3. Grading and reporting

- [ ] 3.1 Grade paired cells from their final implementation state and record convergence additively.
- [ ] 3.2 Extend comparative reporting with ordered pair identity and convergence metrics.
- [ ] 3.3 Add deterministic grading/reporting tests proving pair direction remains distinct and independent-review accuracy is never fabricated.

## 4. Documentation and verification

- [ ] 4.1 Document named treatments and paired mode in host-facing evaluation guidance.
- [ ] 4.2 Run OpenSpec validation, focused tests, plugin regeneration/check, and full `npm run ci`.
- [ ] 4.3 Create plan-only and bounded live-evaluation manifests for Claude→Codex baseline and Codex/Grok candidate pairs; run, grade, report, and write the evidence-backed recommendation.
