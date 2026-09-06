## Context

The shared implement-deliverable observer first excludes planning-only paths, then recognizes product artifacts by executable source extensions and package manifests. A second directory-name exclusion currently removes tests, fixtures, examples, mocks, and most repository scripts before the extension check, causing exact test/tooling candidates to become `unknown`.

The observer is a recovery completeness gate, not a production-runtime impact classifier. Candidate SHA binding, artifact identity, managed-worktree ownership, cleanliness reconciliation, and the full post-implementation gates remain separate controls.

## Goals / Non-Goals

**Goals:**

- Recognize versioned executable and test artifacts as implementation-role evidence regardless of conventional directory name.
- Preserve the explicit planning-only boundary and unknown non-code fail-closed behavior.
- Make the #1470 test-infrastructure recovery case a stable regression.

**Non-Goals:**

- Treat every changed file as implementation evidence.
- Allow OpenSpec, documentation, or workflow-only candidates to skip implementation.
- Bypass candidate epoch binding, ownership checks, test gates, review, or merge authorization.

## Decisions

### Remove directory-name demotion before the existing artifact-type check

Tests, fixtures, examples, mocks, scripts, and tools use the same executable source extensions already accepted for product code. The observer will apply that extension/package-manifest check uniformly after planning-only paths are excluded.

Alternative considered: add a separate allowlist for each test and tooling directory. Rejected because repository layouts vary and filename type is the existing cross-language signal; another directory list would recreate the same false-negative class.

### Keep non-code configuration unknown

Files that are neither explicit planning artifacts nor recognized executable/package artifacts remain `unknown`. This preserves the current fail-closed behavior for ambiguous configuration while fixing the demonstrated code-artifact gap.

Alternative considered: classify every non-planning path as implementation. Rejected because it would broaden recovery admission beyond the demonstrated need.

## Risks / Trade-offs

- [A generated or incidental source-looking file can count as implementation evidence] → Durable ownership and cleanliness checks still gate the candidate, and all post-implementation tests and reviews still run.
- [Repository-specific executable formats remain unrecognized] → The existing extension/package list remains the single policy surface and can be extended with focused evidence later.
