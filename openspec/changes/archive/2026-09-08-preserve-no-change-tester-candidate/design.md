## Context

The test gate captures HEAD before invoking the fix harness, checks post-harness dirt, salvages real uncommitted product work, verifies any new fix commits, re-runs the configured command, and writes Tester evidence from the resulting worktree HEAD. Its default `verifyTestFix` path delegates to the real commit-range verifier. PR delivery then uses the existing Tester rebind boundary to require passed implementation-role evidence for the freshly observed pull request head.

The current prompt and verifier require every successful test-fix invocation to create a commit. In issue #1553 / PR #1555, a retry that needed no file changes therefore created empty local commit `2f25f94d907b4ceba0f577a72a18bb141a352cde` over actual PR head `7f7c48e6482f3dd811275bf8c699bc158556e4c8`. Tester evidence named the local commit, while the authoritative PR remained on the earlier candidate. The rebind boundary correctly failed closed with no SHA-matched implementation-role Tester evidence for the PR head.

The checked-in `factory-gate-v1` manifest already owns two templates, `clean-docs` and `clean-openspec`. Existing loading and rendering code verifies hashes and placeholders, renders run-scoped paths, and normalizes `openspec_change_id`; existing template prose separates implementer work from controller lifecycle evidence. Those are the first reusable seams for this change.

## Goals / Non-Goals

**Goals:**

- Represent a clean successful no-change retry as proof on the existing candidate, not as a demand for a new candidate.
- Exercise the real test-fix verifier and downstream exact-PR-head evidence boundary in the regression.
- Preserve all candidate-changing and fail-closed protections.
- Turn the two current fake-issue templates into deterministically validated inputs for later release packages.
- Pin the approved release simplification and five-package ownership split without implementing future packages.

**Non-Goals:**

- Generalize all harness rounds around a new candidate-transition abstraction.
- Change Tester schemas, scoring, attestation policy, review policy, model defaults, release orchestration, or recovery architecture.
- Run FRG, merge a fake-issue PR, bump a version, tag, publish, install, or deploy.
- Modify historical synthetic fixtures or add live fixture state.

## Decisions

### 1. Model no-change as an outcome of the existing test-gate attempt

The test gate will use its existing `headBefore`/post-invocation HEAD and product-dirt observations to distinguish two paths:

- **No change:** HEAD is unchanged and no product-relevant dirt remains. The gate skips commit-format and trailer checks for that attempt, re-runs the required command, and accepts only an observed zero exit on the preserved candidate.
- **Candidate changed:** HEAD advances or product changes require salvage. Existing commit format, traceability, build-artifact folding, test, publication, review, and exact-head requirements continue to apply.

This deepens the current test-gate seam. It does not introduce a parallel retry controller or a general candidate-integrity layer.

Alternative considered: create an empty commit whenever the command passes without a file change. Rejected because the new SHA is not a published PR candidate and cannot truthfully anchor Tester evidence.

Alternative considered: weaken the rebind verifier by accepting equal trees across different SHAs. Rejected because candidate identity, not tree similarity alone, binds review and Tester authority; this would bypass the useful #1543 protections.

### 2. Make the fix prompt conditional on material work

The test-fix prompt will require the prescribed commit and trailers only when the retry produces material product changes. It will explicitly permit a clean no-change report after running the required command successfully and forbid manufacturing an empty commit merely to satisfy the harness contract.

The deterministic gate remains authoritative. Harness prose does not decide that a no-change retry passed.

Alternative considered: leave the unconditional prompt in place and detect empty commits afterward. Rejected because it continues to manufacture divergent candidates and then requires destructive local history repair.

### 3. Preserve candidate identity through the existing Tester producer and rebind boundary

For a no-change success, the Tester producer will write the trusted command observation against the unchanged candidate. Delivery will continue to freshly observe the PR identity and head, then require SHA-matched passed implementation-role evidence through the existing rebind contract. If the remote head is missing, stale, unrelated, or belongs to a replacement PR without valid rebinding, the path remains fail-closed.

The implementation should pass the expected candidate through existing test-gate/reproduce seams or anchor the worktree to that candidate before production. It must not add an evidence alias that claims two distinct SHAs are the same candidate.

Alternative considered: rewrite the Tester artifact's SHA to the PR head after the suite runs. Rejected because evidence must describe the candidate actually tested.

### 4. Prove the regression across the real verifier boundary with injected I/O

Focused coverage will reproduce this sequence: initial command failure; successful fix invocation; unchanged clean HEAD; real `enforceTestFixCommitFormat` behavior over the empty range; successful retry; Tester persistence; then PR-head/implementation-role rebinding. The prior contract must fail at the mandatory commit verifier or produce evidence for a divergent head, while the corrected contract must retain the PR candidate and bind proof to it.

Sibling cases will keep changed-candidate commit verification and the existing replacement/stale/unobservable negative paths covered. All git, forge, filesystem evidence, harness, and subprocess behavior will use existing dependency seams; no live network, git mutation, or subprocess is needed for the focused regression.

### 5. Validate the existing fake-issue templates through their loader and renderer

Deterministic coverage will load the current manifest and render both manifest templates. Assertions will pin each template's fixture path, executable test path, single normalized OpenSpec change id, resolved placeholders, and implementer/controller responsibility sections. Inputs will include the release-shaped pack-run id and adversarial uppercase, punctuation, repeated-separator, and long ids already handled by normalization.

This reuses `loadFrgPack`, `renderFrgPackIssues`, the manifest template list, and the existing change-id normalizer. It does not add a template registry, a new FRG runner, or a live fixture.

### 6. Freeze the release-simplification contract and package ownership

The approved end state is ordered as follows:

1. Independently verify merged milestone work.
2. Prepare and merge version metadata before FRG work.
3. Freeze the latest `origin/main` candidate as `C`.
4. Run exactly two valid fake issues through the unchanged ordinary pipeline to `pipeline:ready-to-deploy`; do not merge either fake-issue PR.
5. Tag `C`.
6. Verify GitHub publication authoritatively.
7. Finish the ship path by invoking release.

Installation and deployment are excluded. Optional observability #1482 remains optional and retained.

Delivery is split into exactly five packages:

1. **This change:** no-change Tester candidate integrity, deterministic validation of the two existing fake-issue templates, and this design/spec contract.
2. **Future:** new FRG runner.
3. **Future:** complete release command.
4. **Future:** retirement of superseded release surfaces.
5. **Future:** migration to the simplified release path.

Packages 2–5 are context, not unchecked tasks or completion requirements for package 1. Package 1 receives normal independent reviews and GitHub CI; the larger simplification does not reduce those gates.

## Risks / Trade-offs

- **A harness may claim no change while leaving hidden or ignored product output** → Use the gate's existing HEAD and product-dirt observers and require the rerun's observed exit zero; do not trust the claim itself.
- **Skipping commit verification could accidentally cover changed work** → Enter the exception only for unchanged HEAD plus no product-relevant dirt. Salvaged or committed work remains on the existing verification path.
- **A local worktree may not represent the live PR candidate** → Retain fresh authoritative PR-head observation and SHA-matched Tester rebinding. Unobservable or mismatched remote state fails closed.
- **Template tests could duplicate production parsing rules** → Exercise the current manifest loader and renderer and assert their outputs instead of introducing a second parser or normalizer.
- **Recording the future release flow could be mistaken for execution authority** → Keep packages 2–5 out of `tasks.md` and state explicitly that this change authorizes no merge, release, tag, publication, installation, or deployment action.

## Migration Plan

No persisted schema or live-state migration is required. The implementation changes the behavior of future test-fix attempts and adds deterministic checks over current checked-in templates. If the behavior must be rolled back, revert the package-1 code and tests together; no release or deployment side effect from this proposal needs reversal.
