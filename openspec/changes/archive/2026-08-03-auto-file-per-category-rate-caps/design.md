## Context

Three auto-file categories share one implementation path (`autoFileClusterCategory` in
`core/scripts/stages/papercut.ts`):

| Category | Config block | Provenance marker | Entry point |
|---|---|---|---|
| papercut | `papercuts.*` | `<!-- pipeline:papercut-auto-filed -->` | `autoFilePapercuts` |
| correction | `corrections.*` | `<!-- pipeline:correction-auto-filed -->` | `autoFileCorrections` |
| durable-run-blocker | `durable_runs.*` | `<!-- pipeline:durable-run-blocker-auto-filed -->` | `autoFileDurableRunBlockers` |

Each config block exposes its own `auto_file_max_per_window` (default 3). Sequential call sites
(e.g. papercuts then corrections at run finalization) pass that category’s budget into the shared
path.

**Bug (pre-create):** `filedInWindowCount` counts every listed improve issue that carries
`pipeline:backlog` and falls inside the trailing window — no category marker filter and no
open-state filter. All categories therefore compete for one unlabeled pool.

**Asymmetry (post-create):** `reconcilePostCreateState` already filters rate-cap candidates by the
*calling* category’s marker and `state === "OPEN"`. Cross-category overshoot is invisible to the
category that overshot under a shared pre-create count, and pre/post predicates disagree.

**Docs drift:** papercut (and CLAUDE.md’s auto-file exception) claim cross-host safety via
GitHub-authored state; correction config comments / living spec still assert single-host-only
while the code reuses the same cross-host reconcile; durable says it reuses papercut’s cross-host
machinery. Operators cannot tell which claim is true.

Related closed work: #459 (cross-host papercut path), #421 / #500 / #538 (category auto-file).

## Goals / Non-Goals

**Goals:**

- Independent per-category rate budgets that match the three config knobs operators already see.
- One shared rate-cap predicate for pre-create deferral and post-create overflow close (marker,
  open/closed rule, window, backlog label).
- Documented cross-host posture identical for all three categories (they share the machinery).
- Regression tests that fail under shared-count starvation and prove marker-scoped reconcile.

**Non-Goals:**

- Making `pipeline improve --apply` auto-file-safe or rate-capped (issue out of scope).
- Collapsing to a single global shared budget object (rejected — see Decisions).
- Changing default numeric values, window hours, or min-occurrence floors.
- Cross-host hardening of non-auto-file locks (advance / queue / planning — still single-host).
- New config keys, renames, or a fourth auto-file category.

## Decisions

### D1 — Independent per-category counters (not one shared budget object)

**Choice:** Keep the three existing `auto_file_max_per_window` keys; each category counts only
issues whose body includes **that** category’s provenance marker.

**Why not a shared budget:** A truthful shared budget would require collapsing or nesting config
(`auto_file: { max_per_window }` once) so the three knobs stop lying. That is a **BREAKING**
schema/docs change with no operator demand. The knobs already *read* as independent; make
behavior match.

**Why not “shared unless configured differently”:** Two semantics under one key name is worse
than either pure model.

### D2 — Unified rate-cap predicate (pre-create ≡ reconcile)

Both pre-create `filedInWindowCount` and post-create rate-cap overflow SHALL use the same
membership rule, parameterized only by the category marker and that category’s
`maxPerWindow` / window cutoff:

1. Issue body includes **this** category’s provenance marker.
2. Issue is **open** (`state === "OPEN"`).
3. Labels include `pipeline:backlog`.
4. `createdAt` parses and is ≥ window cutoff for this invocation.

Closed issues do not count (matches today’s reconcile survivor set). Issues filed by humans or
by `improve --apply` (no auto-file marker) never count. Issues of other auto-file categories
never count.

Implementation sketch: extract something like
`countsTowardCategoryRateCap(issue, marker, cutoffMs): boolean` used by both sites; avoid a
second divergent inline filter.

### D3 — Cross-host docs: all three inherit the shared path

Code already runs the same GitHub re-read + post-create reconcile for every category. Spec and
comments SHALL say:

- The **auto-file path** (all three categories) is cross-host-safe in the #459 sense
  (GitHub-authored state + post-create reconcile).
- Host-local `/tmp` locks remain a same-host fast path only.
- Correction’s living requirement that forbids claiming cross-host for corrections SHALL be
  rewritten so it no longer contradicts the shared machinery (without inventing stronger
  guarantees than papercut already has).

### D4 — Windows remain per-category config

Each category keeps its own `auto_file_window_hours`. Cap membership uses **that** category’s
window cutoff when that category files or reconciles. No cross-category window merge.

### D5 — Tests at the shared path, not only call sites

Inject `AutoFileDeps` fakes with a mixed backlog of papercut-, correction-, and durable-marked
issues (plus unmarked improve issues). Assert:

- category B still creates when A has filled A’s own cap;
- B defers when B’s own open in-window marked count is at B’s max;
- B’s reconcile does not close A’s open issues when only B overshoots;
- unmarked backlog issues never block or inflate any category’s cap.

## Risks / Trade-offs

- **[Risk] Higher total auto-file volume** (up to sum of per-category max) → **Mitigation:**
  intentional; operators who want a lower total set each category’s max lower. Defaults stay 3
  per category as today.
- **[Risk] TOCTOU still allows brief cross-host overshoot within one category** → **Mitigation:**
  unchanged #459 post-create reconcile; this change only scopes that reconcile correctly per
  marker.
- **[Risk] Doc/spec drift reappears** if a fourth category is added without the shared predicate
  helper → **Mitigation:** helper + tests force marker use; tasks call out comment/spec alignment.

## Migration Plan

- No config migration; existing YAML keeps working with corrected semantics.
- Operators who relied on accidental shared starvation (using one category’s max as a global
  brake) must lower each category’s max or disable unused categories — document in PR body only.
- Rollback: revert the change; behavior returns to shared unlabeled count.

## Open Questions

None blocking implementation. If archive-time review prefers an explicit shared budget instead,
that is a different change with a schema redesign — not this issue’s acceptance bar.
