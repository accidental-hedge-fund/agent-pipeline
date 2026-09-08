## Why

A successful test-fix retry can currently satisfy its mandatory commit check by creating an empty local commit, after which Tester evidence is written for that unpublished local head instead of the actual pull request head. This breaks exact-candidate rebinding even though the retry changed no product files and the pull request candidate remains valid, as observed in issue #1553 / PR #1555.

This is package 1 of 5 in the approved v1.40.1 release-simplification work. It establishes the shared no-change retry contract and records the bounded release direction before later packages add or replace release orchestration.

## What Changes

- Treat a successful, clean test retry with no candidate-changing file modifications as a valid no-change outcome that preserves the current pull request candidate instead of requiring an empty commit.
- Persist Tester proof for the preserved pull request candidate after a no-change retry, while retaining exact-head verification and fail-closed handling when the authoritative remote candidate cannot be observed.
- Keep the existing candidate-changing retry path intact: real changes still require commit, build-artifact folding, publication, independent review, tests, and exact pull-request-head binding.
- Add injected-I/O regression coverage through the real test-fix commit verifier and Tester/PR-head verification boundary, including negative cases for stale, unrelated, replacement, and unobservable candidates.
- Add deterministic validation for the existing `clean-docs` and `clean-openspec` fake-issue templates at their currently scoped paths, including valid normalized OpenSpec identifiers and controller/implementer responsibility separation. No live fixture is added.
- Record the approved release-simplification sequence and five-package split. Only package 1 implementation is part of this change; the FRG runner, complete release command, legacy retirement, and migration remain future work.

## Acceptance Criteria

- [ ] An injected-I/O regression drives a failed test, a successful clean retry with no file or commit change, and the real Tester-to-pull-request-head binding boundary; it fails under the previous mandatory-fix-commit behavior and passes under this contract.
- [ ] A successful no-file-change retry creates no empty commit and persists no Tester attestation for an unpublished head.
- [ ] After a successful no-file-change retry, the preserved candidate SHA and passed implementation-role Tester evidence equal the freshly observed current pull request head.
- [ ] A retry that changes product files still cannot pass without the required commit format and trailers, build-artifact handling, publication, independent review, successful test proof, and exact current-head binding.
- [ ] Replacement pull requests without valid rebinding, unrelated or stale heads, stale Tester evidence, and unobservable authoritative remote state remain rejected.
- [ ] Deterministic tests validate both existing fake-issue templates at their manifest-scoped paths and reject invalid or unnormalized OpenSpec change identifiers without creating a live fixture.
- [ ] Template validation proves implementer-owned tasks remain independently completable before pre-merge archive and controller-owned lifecycle observations remain outside `tasks.md`.
- [ ] A scoped design artifact records metadata-before-FRG, independent verification of merged milestone work, freezing the latest `origin/main` candidate C, exactly two valid ordinary-pipeline fake issues reaching `pipeline:ready-to-deploy` without merge, tagging C, GitHub publication verification, release invocation as the ship endpoint, no installation or deployment, and retention of optional observability #1482.
- [ ] The artifact identifies this issue as package 1 of 5 and marks the new FRG runner, complete release command, retirement, and migration as later-package scope rather than package-1 completion work.
- [ ] Generated host artifacts are fresh and the full `npm run ci` gate passes without reducing model defaults, independent review requirements, or GitHub CI requirements.

## Capabilities

### New Capabilities

- `release-simplification-contract`: Records the approved end-to-end release direction, ordering invariants, exclusions, and five-package delivery boundary.

### Modified Capabilities

- `test-build-gate`: Adds an explicit successful no-change retry outcome that preserves the current candidate while retaining the existing changed-candidate path.
- `harness-step-verification`: Refines test-fix commit verification so a clean, successful no-change retry is exempt from manufacturing a commit, without weakening verification for changed retries.
- `tester-evidence`: Requires no-change retry evidence to bind to the authoritatively observed pull request candidate and preserves fail-closed exact-candidate rules.
- `factory-reliability-gate`: Adds deterministic admission checks for the two existing fake-issue templates, their scoped paths, valid OpenSpec identifiers, and lifecycle ownership partition.

## Impact

- Expected implementation areas: `core/scripts/testgate.ts`, `core/scripts/prompts/test_fix.md`, the existing Tester evidence/rebind integration in `core/scripts/pipeline-run.ts` and `core/scripts/rebind-tester-evidence-after-pr.ts`, and focused tests under `core/test/`.
- Existing FRG assets remain in `core/scripts/frg-packs/factory-gate-v1/templates/` and its manifest; validation is added around those assets rather than adding live fixtures or another runner.
- Generated host SKILLs may refresh through the normal `node scripts/build.mjs` workflow after `core/` changes.
- No merge, FRG execution, version bump, tag, publication, installation, deployment, security-policy, scoring, attestation-schema, model-default, or review-policy change is authorized by this proposal.
