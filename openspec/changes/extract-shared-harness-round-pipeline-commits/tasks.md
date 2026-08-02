## 1. Neutral pipeline-commits module

- [x] 1.1 Add `core/scripts/pipeline-commits.ts` (or equivalent neutral path) exporting `isPipelineInternalCommit`, the OpenSpec archive prefix, and the visual publish prefix + exact-match pattern used by the classifier.
- [x] 1.2 Move classification logic out of `stages/pre_merge.ts` into the neutral module without changing the tested truth table (archive + exact visual publish internal; docs/auto-format/auto-fix not).
- [x] 1.3 Single-source producer prefixes: visual publish authoring and OpenSpec archive authoring import the same constants the classifier uses.
- [x] 1.4 Rewire all consumers (pre_merge SHA gate / currency helpers, shipcheck revalidation, tests, any visual imports of the pattern) to the neutral module.
- [x] 1.5 Ensure `stages/shipcheck.ts` has no import from `pre_merge` for classification; add a source/import-graph regression test that fails if reintroduced.
- [x] 1.6 Keep or re-home classifier unit tests so archive, visual exact, visual near-miss, docs, auto-format, and auto-fix cases still bite.

## 2. Shared harness-round helper

- [x] 2.1 Add `core/scripts/harness-round.ts` (or equivalent) implementing reattach (optional) → headBefore → invoke → salvage → verify callbacks → optional format/test → optional push, with injectable deps.
- [x] 2.2 Document the options bag so stage-specific commit gates, salvage labels, and product outcomes remain caller-supplied.
- [x] 2.3 Add unit tests for the helper skeleton (head capture before invoke; salvage on dirty no-commit; no salvage on clean no-commit; reattach failure short-circuits invoke when enabled) using fake deps only.

## 3. Migrate stage consumers

- [x] 3.1 Migrate fix-round to the shared helper; keep fix commit-format, crash-retry, and external-commit paths green.
- [x] 3.2 Migrate planning implement (success and existing crash/timeout salvage paths) to the shared helper; keep implement issue-ref + format/test outcomes.
- [x] 3.3 Migrate visual-fix and eval-fix to the shared helper; keep prescribed fix subjects and push behavior.
- [x] 3.4 Migrate pre-merge bounded auto-fix to the shared helper; keep amend-to-auto-fix-prefix, one-attempt bound, noop-clean, push, and delta re-review outcomes.
- [x] 3.5 Prefer migrating test-fix (`testgate.ts`) when mechanical; if deferred, note the exemption in code comments without blocking the issue.

## 4. #787 repair_pipeline_item disposition

- [x] 4.1 Confirm substantive repair goes through shared auto-fix / shared-round (preferred) rather than a private full skeleton.
- [x] 4.2 Preserve recovery-shell invariants: attempt breadcrumb, ownership proof, idempotent marked-push reconciliation, refuse unmarked human commits.
- [x] 4.3 Add/adjust regression tests that fail if the shell drops breadcrumb/ownership refusal or if the substantive path reintroduces a private full implementer skeleton.

## 5. Living-spec alignment and verification

- [x] 5.1 Confirm OpenSpec deltas for modified capabilities match implementation (shipcheck import break, review-sha classifier set, auto-format not internal, shared-round consumers).
- [x] 5.2 Run existing reattach/salvage/SHA-gate/visual-publish/auto-format classification suites and prove they still bite.
- [x] 5.3 Regenerate the mirror: `node scripts/build.mjs`.
- [x] 5.4 Run `openspec validate extract-shared-harness-round-pipeline-commits` and `npm run ci` from repo root; fix until green.
