## Why

Config exposes three near-identical auto-file budgets (`papercuts`, `corrections`, `durable_runs`), each with its own `auto_file_max_per_window`, but pre-create rate accounting is a single unlabeled backlog count shared across categories. Enabling all three at `max=3` does not yield three independent budgets of three — the first category to run can exhaust the window for the others. Reconcile is already marker-scoped per category, so cross-category overshoot is never closed by the category that overshot, and docs disagree on whether correction/durable inherit papercut’s cross-host claim.

## What Changes

- Make each auto-file category’s per-window rate cap **independent**: pre-create counting and post-create rate-cap reconciliation both filter to that category’s provenance marker (and the same open/closed rule), so `max=3` on each of three enabled categories allows up to three open auto-filed issues **per category** in each category’s window.
- Align pre-create and reconcile rate-cap predicates (marker set, open/closed rule, category filter) so they cannot disagree on what “counts toward the cap.”
- Align CLAUDE.md / AGENTS.md / config & types comments so all three categories document the same cross-host posture: they share the GitHub-authored state + post-create reconciliation machinery (or, if implementation discovers a real gap, document none of them as cross-host — no mixed claims).
- Add regression tests for multi-category starvation (category A filling the shared count must not starve B/C) and for marker-scoped overshoot reconcile.
- No config schema **BREAKING** rename: keep the three existing `auto_file_max_per_window` knobs; change only their semantics so they match what operators already read them as (per-category budgets). Explicitly reject a silent shared-budget reinterpretation without a single documented shared object.

## Capabilities

### New Capabilities

<!-- none — this is a correctness fix across existing auto-file capabilities -->

### Modified Capabilities

- `papercut-auto-file`: rate-cap counting and cross-host rate-cap reconcile SHALL be scoped to papercut provenance markers only (not all backlog improve issues).
- `correction-auto-file`: rate cap SHALL be independent of papercut/durable counts; concurrency/docs SHALL match the shared cross-host machinery rather than claiming single-host only while reusing cross-host reconcile.
- `durable-run-blocker-auto-file`: rate cap SHALL be independent of papercut/correction counts; cross-host language remains consistent with the shared path.

## Impact

- **Code**: `core/scripts/stages/papercut.ts` (`filedInWindowCount`, `reconcilePostCreateState`, category markers); call sites already pass per-category `maxPerWindow` from config.
- **Config / types / docs**: comments in `types.ts`, `config.ts` schema describe text, CLAUDE.md / AGENTS.md concurrency notes for auto-file categories — not schema keys.
- **Tests**: multi-category auto-file unit tests (deps-injected; no real network).
- **Out of scope**: making `improve --apply` fully auto-file-safe; introducing a fourth category; changing default numeric budgets; autonomous merge.

## Acceptance criteria

- [ ] With all three auto-file categories enabled and each `auto_file_max_per_window: 3`, filing three papercut issues in-window does **not** prevent a subsequent correction or durable-run-blocker create in the same wall-clock window when that category still has budget remaining.
- [ ] Pre-create deferred (rate-cap) decisions and post-create rate-cap closes use the **same** predicate: category provenance marker + the same open/closed rule + in-window created-at + backlog label.
- [ ] Rate-cap overflow reconcile for category A never closes (or refuses solely because of) open auto-filed issues that carry only category B’s marker.
- [ ] Human-managed or `pipeline improve --apply` backlog issues (no auto-file provenance marker) never count toward any category’s auto-file rate cap.
- [ ] CLAUDE.md / AGENTS.md / config+types comments agree: all three categories inherit the same cross-host auto-file posture (or none claim it).
- [ ] Unit tests cover multi-category non-starvation and marker-scoped overshoot reconcile; they fail under the pre-fix shared-count behavior.
- [ ] `npm run ci` is green; any `core/` edits regenerate `plugin/` in the same change.
