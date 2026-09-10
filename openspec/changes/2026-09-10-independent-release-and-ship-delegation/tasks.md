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
