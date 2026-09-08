## 1. Exact Candidate and Result Model

- [x] 1.1 Add the versioned release-owned FRG result schema for candidate epoch, exact `origin/main` SHA, candidate input identities, two fixed template slots, issue/run/PR identities, effective worker configuration, normalized observations, outcome, and cleanup facts; verify parser tests reject missing, extra-slot, malformed, or cross-epoch bindings.
- [x] 1.2 Compose candidate selection with the shared resolve-and-prepare seam and candidate-root template/manifest/lockfile loading; verify deterministic tests select the freshly observed `origin/main` SHA and reject installed-engine, operator-tree, wrong-root, and fixture-head substitution.
- [x] 1.3 Add fresh candidate movement checks at verification and resume boundaries; verify movement from `C1` to `C2` marks `C1` stale and cannot rewrite or reuse its evidence as proof for `C2`.

## 2. Exact-Pair Creation and Resume

- [x] 2.1 Add durable intended-slot provenance for exactly `clean-docs` and `clean-openspec` before remote mutation; verify schema and rendering tests enforce exactly two distinct candidate-owned templates.
- [x] 2.2 Implement authoritative pre-create reconciliation for zero, one, duplicate, and foreign matches; verify tests create only a proven-absent slot, adopt a unique match, and classify ambiguity without a remote create.
- [x] 2.3 Persist partial and uncertain create outcomes and resume the same intended pair; verify injected lost-response and restart tests reconcile the created issue and never create a third issue.

## 3. Ordinary Loop Execution

- [x] 3.1 Invoke the prepared candidate launcher through the existing ordinary loop with the two recorded issue numbers; verify argv/contract tests reject broad label selection, missing or extra issues, and use of an installed or operator-tree launcher.
- [x] 3.2 Reuse ordinary lifecycle supervision, effective repository worker policy, and domain-aware issue locks while disabling FRG repair auto-filing through supported configuration; verify tests observe ordinary lock acquisition and no second scheduler, lease-transfer, or owner-observation state.
- [x] 3.3 Enforce the no-merge and no-fixture-engine-repair boundaries; verify injected command and mutation tests show the FRG path cannot invoke merge surfaces, weaken ordinary gates, repair pipeline code through fixtures, or launch a replacement pair.

## 4. Independent Observation and Classification

- [x] 4.1 Build the release-owned observer from existing forge, CI, review, Tester, provenance, and ordinary-run evidence seams; verify a current unmerged head with matching ready-to-deploy, green CI, accepted independent review, passed Tester evidence, and expected provenance is accepted.
- [x] 4.2 Validate every candidate-bearing observation against the current fixture PR head and authoritative source; verify stale, forged, label-only, comment-only, public-hash-only, worker-boolean, wrong-head, missing-evidence, and merged-fixture cases cannot pass.
- [x] 4.3 Implement the deterministic four-way non-pass classifier and existing lifecycle mappings; verify ordinary revision stays with ordinary issue ownership, observer outage becomes an external-condition wait, demonstrated regression retains exact-candidate evidence, and gate defect names the shared owning contract.
- [x] 4.4 Persist each final result atomically before ownership-safe nonmerge cleanup and append cleanup facts without changing the proof outcome; verify cleanup success, identity mismatch, failure, and uncertainty tests preserve evidence and report cleanup debt.

## 5. Release-Path Simplification

- [x] 5.1 Add one verifier for the exact-candidate pair result and migrate package-2 release-path callers to it; verify a conforming result passes and score, threshold, HMAC, qualification, factory-request, lease-handoff, owner-observation, and public-hash artifacts alone do not.
- [x] 5.2 Remove package-2 dependencies on prepare, score, attest, re-observe, nested pack ownership, and installed-CLI qualification without adapting the new result into legacy shapes; verify dependency/command tests show the new path has one runner/observer state machine while untouched later-package callers remain explicit.
- [x] 5.3 Update the release-owned status and documentation surfaces for the new outcome and cleanup-debt contract; verify generated command/config documentation describes exact-candidate proof, explicit external waits, and the no-merge/package boundary.

## 6. Deterministic Regression Migration

- [x] 6.1 Inventory installed-qualification tests by observable product invariant versus deleted release choreography; verify the disposition maps every retained admission, accounting, exact-source, CLI, process-fault, and recovery assertion to a normal deterministic CI test.
- [x] 6.2 Move retained assertions into the closest ordinary CLI and recovery suites and delete tests whose only subject is scoring, matrix artifacts, HMAC, or qualification ordering; verify the targeted normal test suites fail under representative launcher/fault regressions and use no real network, git, or model calls.
- [x] 6.3 Make remaining exact-candidate inventory checks enumerate the materialized candidate root or commit tree; verify an uncommitted operator-side `core/test` file does not affect the exact-HEAD check while an actual trusted-candidate inventory mismatch still fails.
- [x] 6.4 Add or consolidate deterministic coverage for exact-two cardinality, partial create/resume, current candidate selection, candidate movement, authoritative current-head success, forged/stale/wrong-head rejection, no merge, external wait, and ownership-safe cleanup debt; verify all named tests pass without creating live synthetic fixtures.

## 7. Repository Gates and Review

- [x] 7.1 Run focused core tests for the new runner, observer, classifier, reconciliation, candidate selection, cleanup, and migrated CLI/fault cases; verify all targeted commands exit zero.
- [x] 7.2 Run `node scripts/build.mjs` after all `core/` edits and verify `node scripts/build.mjs --check` reports every generated host SKILL fresh.
- [x] 7.3 Run `npm run ci` from the repository root and verify the complete core, generated-artifact, install-smoke, OpenSpec, docs, and scripts gates pass.
- [ ] 7.4 Obtain independent standards and spec reviews, address every blocking finding with focused regression coverage, and verify both reviewers approve the final diff.
- [ ] 7.5 Push the implementation PR and verify GitHub PR CI is green without running live synthetic fixtures or performing release, merge, tag, publication, promotion, installation, or deployment actions.
