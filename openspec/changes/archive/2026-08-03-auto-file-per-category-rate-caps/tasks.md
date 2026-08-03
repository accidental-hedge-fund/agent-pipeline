## 1. Shared rate-cap predicate

- [x] 1.1 Extract a single helper in `core/scripts/stages/papercut.ts` that decides whether a listed improve issue counts toward a category rate cap (open + `pipeline:backlog` + category provenance marker + `createdAt` ≥ cutoff)
- [x] 1.2 Use that helper for pre-create `filedInWindowCount` inside `autoFileClusterCategory` (pass the active category marker; stop counting unmarked/other-category/closed issues)
- [x] 1.3 Use the same helper for post-create rate-cap overflow selection in `reconcilePostCreateState` so pre-create and reconcile cannot diverge

## 2. Docs and comment alignment

- [x] 2.1 Update `types.ts` / `config.ts` comments for `corrections` (and durable if needed) so they no longer claim single-host-only auto-file while papercut claims cross-host; state that all three inherit the shared GitHub-state + post-create reconcile path
- [x] 2.2 Align CLAUDE.md / AGENTS.md concurrency notes so papercut, correction, and durable-run-blocker auto-file share one cross-host posture (no mixed claims)
- [x] 2.3 Refresh config-describe / schema describe text if it still implies a shared unlabeled budget or single-host-only corrections

## 3. Regression tests

- [x] 3.1 Add a multi-category non-starvation test: with each max=3, three open papercut-auto-filed in-window issues do not prevent a correction (or durable) create when that category has budget remaining
- [x] 3.2 Add a same-category cap test: when a category’s own open in-window marked count is at max, further creates for that category are deferred
- [x] 3.3 Add a marker-scoped reconcile test: category B rate-cap overflow close does not close open category A issues; unmarked improve issues never inflate any cap
- [x] 3.4 Prove at least one new test fails under the pre-fix shared unlabeled count (or document the failing assertion before applying the fix)

## 4. Verify and mirror

- [x] 4.1 Run targeted unit tests for papercut/auto-file coverage from `core/`
- [x] 4.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/`
- [x] 4.3 Run `npm run ci` from repo root and fix until green
- [x] 4.4 Run `openspec validate auto-file-per-category-rate-caps` (and `openspec validate --all` if required by the gate) after any delta-spec touch-ups
