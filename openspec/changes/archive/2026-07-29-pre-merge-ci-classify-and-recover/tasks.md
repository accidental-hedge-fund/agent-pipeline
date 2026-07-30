## 1. Types, recipes, and config surface

- [x] 1.1 Add `ci-exhausted` to `BLOCKER_KINDS` and a non-empty `BLOCKER_RECIPES` entry that directs operators to inspect check URLs/classification, fix CI, push, clear `blocked`, and re-run (not review `--override` as primary).
- [x] 1.2 Wire `ci-exhausted` through intervention/accounting mapping if required (e.g. map to `test-build-failure` human-intervention kind) without breaking existing kind exhaustiveness tests.
- [x] 1.3 Update `blocked-recipes.test.ts` (and any other exhaustive BlockerKind tests) for the new kind and snapshot/string assertions.
- [x] 1.4 Add optional config key(s) for assertion auto-fix enablement (default off/0) and any re-run toggle if needed; document defaults in config schema comments.

## 2. Classification helper

- [x] 2.1 Implement a pure `classifyCiFailure(...)` helper (check metadata + optional log excerpt → `infra` | `assertion` | `unknown`) with deterministic rules and mixed-set → `assertion` policy.
- [x] 2.2 Add unit tests for infra signature (including IPC deserialize), assertion-like output, unknown fallback, and mixed sets (no network).

## 3. GH / deps seams

- [x] 3.1 Confirm real `gh` shapes for failed-run re-run and log excerpt (e.g. `gh run rerun`, run id from check `link`) before coding wrappers.
- [x] 3.2 Add `rerunFailedWorkflows` (or equivalent) and `fetchCheckLogExcerpt` in `gh.ts` with injectable production defaults.
- [x] 3.3 Extend `AdvancePreMergeDeps` (and related fakes in tests) with re-run, log-excerpt, and optional assertion-fix seams.

## 4. Durable per-head recovery markers

- [x] 4.1 Extend pre-merge polling / run-store state with durable fields: re-run attempted SHA, archive failed-run recovery SHA, assertion-fix attempted SHA (survive process restart).
- [x] 4.2 Load/persist markers so a resumed process does not re-consume budget for the same head SHA; new head SHA gets a fresh budget.

## 5. Pre-merge recovery ladder

- [x] 5.1 Replace escalate-only definitive-red path in `pre_merge.ts` with: rebase (existing) → classify → infra/unknown re-run once → archive-only+prior-green recovery (re-run first, then one-shot close+reopen if still applicable) → optional assertion fix → `setBlocked(..., "ci-exhausted")`.
- [x] 5.2 Build rich block reason: failing checks + conclusion, URL(s), head SHA, pre-archive green SHA when applicable, classification, log excerpt, operator next steps.
- [x] 5.3 Ensure #181 non-regression: no infinite `waiting`/re-archive on definitive red when budget exhausted; zero-run #281 path remains intact.
- [x] 5.4 Keep `ci_mode: local` path unchanged regarding GitHub re-run/classify (local blocks stay on existing kinds/reasons).

## 6. Tests and gate

- [x] 6.1 Unit tests: flake fail → re-run → green advances without `setBlocked`.
- [x] 6.2 Unit tests: double fail after re-run → single `ci-exhausted` block; re-run seam not called twice for same SHA.
- [x] 6.3 Unit tests: durable marker after simulated restart skips second re-run.
- [x] 6.4 Unit tests: archive-only + prior green prefers recovery over immediate block; assertion archive-only does not close+reopen to hide product red.
- [x] 6.5 Unit tests: assertion fix disabled escalates without fix seam; enabled runs once then stops (if feature implemented in this change).
- [x] 6.6 Update existing pre-merge convergence tests that expect immediate `needs-human` on red CI so they match the new ladder (still no spin).
- [x] 6.7 Run `node scripts/build.mjs` after `core/` edits; commit regenerated `plugin/` with the implementation.
- [x] 6.8 Run `npm run ci` from repo root and fix until green; `openspec validate pre-merge-ci-classify-and-recover` remains valid through implementation.
