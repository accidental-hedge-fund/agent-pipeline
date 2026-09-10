## 1. Complete release

- [x] 1.1 Add milestone closure, merged-PR, and origin containment validation.
- [x] 1.2 Reconcile/prepare metadata before freezing C without switching the caller checkout.
- [x] 1.3 Run and verify exact-candidate FRG, immutable annotated tag, exact publisher workflow, and non-draft publication.
- [x] 1.4 Make retry and completed invocation observer-reconciled and same-host serialized.

## 2. Authority composition

- [x] 2.1 Keep an explicit prepare-only helper for factory and merge-queue callers.
- [x] 2.2 Make direct release complete independently and SemVer ship delegate once; keep continuous ship integration-only.
- [x] 2.3 Disable competing auto-tag ownership and make the tag workflow own publication/docs only.

## 3. Contracts and verification

- [x] 3.1 Add deterministic ordering, containment, reuse, stale-C, FRG, tag, publication, idempotence, and ship delegation tests.
- [x] 3.2 Update CLI/catalog/docs and release/ship delta specifications.
- [x] 3.3 Run build freshness, strict OpenSpec validation, focused tests, diff check, and full CI.

## 4. Recovered audit corrections

- [ ] 4.1 Replace local-record FRG completion with fresh/clean-checkout authoritative exact-pair discovery and read-only forge/CI/review/Tester reconstruction; never create a replacement pair for a tagged retry.
- [ ] 4.2 Give `release.yml` the single bounded exact-C recovery path, distinguish authoritative exact-tag 404 from unknown failures in both owners, and enforce tag checkout, root/core version guards, publication, main checkout, dependency install, then docs order.
- [ ] 4.3 Apply one scope/version/exact-head nonempty-green-CI/merge-containment validator to every open, transition-to-merged, and already-merged metadata reuse path; make packed prepare reject before mutation or remain wholly worktree-isolated.
- [ ] 4.4 Add production-seam regressions for clean-checkout FRG reconstruction/no-create, publisher recovery/no-run and unknown-vs-404, every metadata reuse state, packed caller safety, root/core workflow order, and observable pre/post tag-boundary movement. Preserve and document the unavoidable non-atomic main/tag interval, then rerun all completion gates.
