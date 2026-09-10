## Why

The final regression gate currently layers installed-CLI qualification, a scored scenario matrix, HMAC attestation, and nested pack ownership over the ordinary pipeline. Release simplification package 2 replaces that release-path choreography with a direct proof that one exact `origin/main` engine candidate can take the retained clean-docs and clean-openspec fixtures through the normal issue-to-ready-to-deploy path.

## What Changes

- Add one release-owned FRG runner/observer contract for an exact candidate and exactly two explicit fixture issues.
- Reuse candidate resolve-and-prepare, the ordinary loop, ordinary domain-aware issue locks, and authoritative GitHub/CI/review/Tester evidence instead of introducing a second scheduler or recovery owner.
- Make fixture creation restart-safe and ambiguity-safe: the intended clean-docs/clean-openspec pair is durably identified and reconciled before any create, so partial or uncertain creates cannot produce a third issue.
- Replace fixture-worker assertions, labels alone, scoring, and attestation with independently observed current-PR-head evidence, expected template provenance, and proof that fixture PRs remain unmerged.
- Persist the candidate epoch, template/issue/run/PR identities, effective worker configuration, outcome, and cleanup facts before ownership-safe nonmerge cleanup.
- Classify unsuccessful observations as ordinary review revision, external/transient inconclusive state, exact-candidate regression, or gate defect without rebinding the candidate or replacing the fixture pair.
- Remove installed-CLI qualification and matrix scoring as release-path prerequisites. Preserve real admission, accounting, exact-source, CLI, and recovery regressions as deterministic normal CI coverage.
- Correct exact-candidate inventory checks so uncommitted files in the operator checkout cannot contaminate the inventory of a candidate materialized from exact HEAD.
- Keep package 3 responsible for complete release/ship integration and package 4 responsible for dependency-checked retirement of remaining obsolete callers. This change does not merge fixtures, release, tag, publish, promote, install, or deploy.

## Acceptance Criteria

- [ ] A run record binds one candidate SHA selected from the current `origin/main`, its candidate-owned templates and `core/package-lock.json`, and a prepared candidate engine; an installed engine, operator checkout source, or fixture PR head cannot satisfy that binding.
- [ ] The runner creates or adopts one clean-docs issue and one clean-openspec issue, and deterministic restart tests prove partial creation, an uncertain create response, and resumed observation reconcile those same identities without creating a third issue.
- [ ] The candidate invokes the unchanged ordinary loop with exactly the two recorded issue numbers and no broad label selector, merge command, fixture-side engine repair, weakened gate, auto-file repair, or replacement pair.
- [ ] Each fixture passes only when fresh authoritative observations bind `pipeline:ready-to-deploy`, green CI, accepted independent review, Tester evidence, and expected template provenance to the current unmerged PR head; forged, stale, wrong-head, label-only, comment-only, hash-only, or worker-authored pass claims fail.
- [ ] Observer-owned evidence is stored outside fixture-worker control in one compact release-owned result containing candidate epoch, template, issue, ordinary run, PR-head, effective worker configuration, outcome, and cleanup bindings.
- [ ] Same-host release exclusion and ordinary domain-aware issue locks remain effective, and no cross-host scheduler, candidate lease-transfer protocol, nested owner-observation protocol, or second recovery controller is required.
- [ ] An unsuccessful observation produces one of four explicit outcomes—ordinary review revision, external/transient inconclusive, demonstrated exact-candidate regression, or gate defect—and neither creates a new pair nor silently changes the candidate.
- [ ] Movement of `origin/main` makes prior evidence stale and requires a new candidate epoch and re-proof; it never substitutes the new head into the existing result.
- [ ] The final outcome is durably persisted before cleanup; ownership-safe cleanup never merges, cleanup uncertainty is reported as cleanup debt, and cleanup cannot erase a proven result or manufacture a pass.
- [ ] Release-path prepare, score, attest, re-observe, factory-request, installed-CLI qualification, and matrix-scoring dependencies are absent from the new runner/observer verification path, while useful ordinary CLI and fault cases remain enforced by normal deterministic CI.
- [ ] Exact-HEAD inventory validation reads the trusted candidate inventory, so adding an uncommitted file under the operator checkout's `core/test` does not make `npm run ci` fail and the inventory assertion remains active.
- [ ] Deterministic tests cover exact-two enforcement, partial-create reconciliation and resume, stale/forged/wrong-head evidence, current green ready-to-deploy proof, no merge, external waits, cleanup debt, candidate movement, and selection of the current `origin/main` candidate.
- [ ] Core changes regenerate the host artifacts, `npm run ci` passes, independent reviews approve the implementation, and PR CI is green.
- [ ] The result preserves the approved later-phase contract: release metadata precedes FRG, the proven candidate is the eventual tag target, publication remains release-owned, and ship completion invokes release without this package performing those actions.

## Capabilities

### New Capabilities

- `exact-candidate-frg`: Defines the two-issue runner/observer, authoritative result contract, reconciliation, classification, candidate epochs, and cleanup behavior.

### Modified Capabilities

- `factory-reliability-gate`: Replaces the release-path scored pack, attestation, qualification, and nested ownership requirements with the exact-pair result and verification contract as callers leave the path.
- `installed-cli-fault-qualification`: Removes qualification from the release gate, retains genuine CLI/fault regression coverage in ordinary CI, and binds any remaining inventory assertion to its trusted candidate source.
- `release-simplification-contract`: Records package 2 ownership and preserves the boundary with later release, retirement, and migration packages.

## Impact

The implementation will primarily affect the current FRG and factory-release modules under `core/scripts/`, their pack templates and tests, installed-CLI qualification tests, candidate-engine consumer inventory, command/docs surfaces generated from `core/`, and release-owned runtime records under the existing pipeline state area. It changes the release-path FRG evidence schema and retires old internal choreography; it does not add merge or release authority and does not alter the ordinary loop's stage or review policy.
