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

- [x] 4.1 Replace local-record FRG completion with fresh/clean-checkout authoritative exact-pair discovery and read-only forge/CI/review/Tester reconstruction; never create a replacement pair for a tagged retry.
- [x] 4.2 Implement the remote-evidence publisher state machine keyed by `release.yml` + tag + C (absent/pending/failed/successful). Add the exact `workflow_dispatch` contract (`tag`, `candidate`, `--ref` the tag) to the same publication job. Bound one dispatch and one rerun from remote runs, not local flags. Distinguish tagged-stale-C from completed-tag-plus-later-docs.
- [x] 4.3 Apply one scope/version/exact-head nonempty-green-CI/merge-containment validator to every open, transition-to-merged, already-merged, and deleted-head reuse path. Fail closed when a version is on main without that PR proof. Reject `release prepare --packed-candidate` during argv validation before any Git command.
- [x] 4.4 Replace `release.yml` `gh release view &>/dev/null` and CLI `/release not found/i` with `isHttp404Signal` plus `isGithubAuthOrPermissionError`. Enforce tag checkout, root/core version guards, main=C, publication, main checkout, dependency install, then docs order.
- [x] 4.5 Map and test prepare-only callers (`release prepare`, `factory-release prepare`, merge-queue `--release-when-complete`) versus complete release and SemVer ship delegation. Prove `advance`/`single`/`loop` still cannot merge or tag, continuous ship stays integration-only, and no install/promotion/deployment runs.
- [x] 4.6 Add production-seam regressions for: clean-checkout tagged retry; metadata PR open, merge-during-observe, already merged with deleted branch, wrong path/version, empty or wrong-head CI, merge not contained in C, and version-on-main without provenance; publisher run absent/pending/failed/success with one dispatch and one rerun across a fresh invocation; 404 versus auth/network/5xx Release observation; pre-tag, post-tag, and workflow pre-publication main movement with no force/delete/retag; workflow tag checkout, root/core guards, publication, main checkout, dependency install, and docs ordering. Preserve and document the unavoidable non-atomic main/tag interval, then rerun `node scripts/build.mjs`, `openspec validate --all`, focused release/workflow/ship tests, and `npm run ci`.
- [x] 4.7 Observe publisher runs via exhaustive exact-identity workflow-run pagination (`head_sha=C`, fail closed unless `total_count` matches). `release.yml` requires exact TAG/C annotation before Release create/edit. Add regressions for ≥100 runs and same-C divergent notes.
