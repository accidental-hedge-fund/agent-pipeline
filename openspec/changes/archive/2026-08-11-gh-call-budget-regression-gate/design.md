## Context

See `proposal.md` for motivation. Current state that shapes the approach:

- `GhMetricsCollector` (`core/scripts/gh.ts`) records per-call CLI `category`
  (first two `gh` args) and aggregate `call_count` / latency percentiles. The
  `gh_metrics_summary` event mirrors that shape. There is **no** per typed-wrapper
  breakdown (`getPrDetail` vs `getPrChecks` vs …).
- Stage logic is already unit-testable through deps seams
  (`AdvancePreMergeDeps`, review/SHA/verify deps, `PreMergePollingContext`).
  Pre-merge multi-tick tests already count some deps calls
  (`core/test/pre-merge-entry-gate-head-anchor.test.ts`) but do **not** pin a
  total-invocation ceiling that fails if the entry-gate memo is removed.
- #816 entry-gate head memo is merged: after first clean proceed, later pending-CI
  ticks skip head-bound gates. That amortization is what the pre-merge budget
  ceiling must lock in.
- Unit tests must not use real network, git, or subprocess (repo test discipline).

Constraints:

- Additive metrics only; do not change routing or gate outcomes based on budgets.
- Rigor over latency: budgets assert call *count*, not weaker review policy.
- Reconcile-cycle budget is deferred to #1002.

## Goals / Non-Goals

**Goals:**

- Surface per-run `gh` call counts by **typed wrapper name** in the collector
  summary and in the `gh_metrics_summary` event payload.
- Pin two unit-test ceilings (named constants + regression comments):
  1. Pre-merge multi-tick pending-CI poll under shared polling context.
  2. Full advance walk with injectable deps.
- Ensure the pre-merge ceiling is low enough that removing the entry-gate memo
  skip path fails the test.
- Keep assertions pure deps-counting (or in-memory collector recording) with no
  real I/O.

**Non-Goals:**

- Runtime enforcement that aborts production runs when a budget is exceeded.
- Reconcile-cycle budget (#1002).
- Changing entry-gate policy, CI recovery ladder, review severity, or merge authority.
- Replacing CLI `category` / `slowest_calls` with wrapper names only.
- Cross-host or durable budget ledgers.
- Measuring real wall-clock `gh` latency in unit tests (counts only).

## Decisions

### 1. Breakdown key = typed wrapper name, additive to category

**Decision:** Extend `GhMetricsCollector.record` so each invocation can attach an
optional stable **wrapper name** (e.g. `getPrDetail`, `getPrChecks`,
`getIssueDetail`). `summary()` and `gh_metrics_summary` SHALL include a
`by_wrapper` map (or equivalent ordered list of `{ wrapper, count }` entries)
where keys are those names and values are call counts. Existing fields
(`call_count`, `total_ms`, `p50_ms`, `p95_ms`, `slowest_calls` with `category`)
remain. Calls recorded without a wrapper name SHALL either be omitted from
`by_wrapper` or bucketed under a single explicit sentinel such as
`"unknown"` — pick one behavior and document it; prefer **omit from
`by_wrapper`** so production typed helpers always supply a name and tests can
assert completeness separately if needed.

**Rationale:** Issue asks for wrapper-name breakdown, not another CLI category
roll-up. Categories stay useful for slowest-call diagnosis; wrappers match the
deps seams used in budget tests.

**Alternatives considered:**

- *Derive wrapper from category only.* Lossy (`pr view` maps to many helpers).
  Rejected.
- *Replace category with wrapper.* Breaks existing consumers of
  `slowest_calls.category`. Rejected.
- *Only count in tests, no event field.* Fails the emit half of the issue.
  Rejected.

### 2. Production recording at the typed helper → `ghRun` boundary

**Decision:** Thread wrapper name from each public typed helper into the
metrics path (via `GhRunOptions` or an equivalent internal parameter) when that
helper invokes `ghRun` / shared runners. Direct low-level `ghRun` callers that
are not named wrappers may omit the name. Do **not** invent wrapper names from
raw arg lists.

**Rationale:** Names stay stable API identifiers; no secret/user content enters
the key space.

**Alternatives considered:**

- *Stack inspection / caller name.* Fragile across minify/strip/async.
  Rejected.
- *Central registry mapping categories → wrappers.* Incomplete and brittle.
  Rejected.

### 3. Unit budgets count injectable deps invocations, not live `ghRun`

**Decision:** Budget tests instrument the deps object (or thin wrappers around
each injected function) and sum invocation counts. They do not start a real
collector against subprocesses. Optionally, tests may also drive the collector
with synthetic `record(..., wrapper)` calls to unit-test `by_wrapper` emission
shape separately.

**Rationale:** Matches existing test discipline and the issue’s “deps seams”
evidence. Production telemetry and unit budgets share the *same dimension*
(wrapper / deps method names) without requiring network.

**Alternatives considered:**

- *Spawn real `gh` under a collector.* Violates no-network unit policy.
  Rejected.
- *Only assert `by_wrapper` from a simulated full pipeline with real
  `setGhCollector`.* Useful for collector tests, insufficient alone for stage
  control-flow regressions (memo skip lives above `ghRun`).

### 4. Two pinned ceilings as named constants

**Decision:**

| Constant (illustrative name) | Scenario | Regression it catches |
| --- | --- | --- |
| `PRE_MERGE_POLL_DEPS_CEILING` | Shared `PreMergePollingContext`, `getPrChecks` pending for fixed N ticks (N ≥ 10 recommended), unchanged open head | Loss of entry-gate head memo (#816) or reintroduction of full per-tick entry stack / redundant identity resolution |
| `ADVANCE_WALK_DEPS_CEILING` | Deterministic full advance walk with injectable deps (fixed issue/PR fixtures, no harness network) | Silent reintroduction of redundant GitHub reads across the advance path after efficiency work |

Exact numeric values SHALL be calibrated at implementation time against the
current green baseline **after** #816, with a small intentional headroom only if
needed for non-determinism that is already present; prefer tight ceilings.
Each constant lives next to the test (or in a tiny shared test helper) with a
comment naming the regression. Raising a ceiling is a deliberate, reviewed edit.

**Rationale:** Issue requires explicit constants + comments, not magic numbers
inline in `assert`.

### 5. Pre-merge budget must fail if entry-gate memo is removed

**Decision:** Structure the pre-merge budget test so the ceiling is **below**
the total deps-invocation count observed when head-bound gates re-run every
tick for all N pending ticks. Implementation proof: either a secondary
assertion that estimates “without memo” cost, or a documented calibration note
plus a structural test (e.g. force memo miss path multiplies gate deps and
exceeds the constant). Prefer a **proving** approach: temporarily counting
full-stack cost in the same test file (or a paired test) shows
`fullStackCost > PRE_MERGE_POLL_DEPS_CEILING` while the memo path stays
`<= ceiling`.

**Rationale:** Acceptance criterion is falsifiable: removing the memo must fail
`npm test`.

### 6. Full advance walk scope

**Decision:** “Full advance walk” means one deterministic multi-stage (or
multi-step within advance) unit scenario that exercises the primary injectable
`gh`/deps surface of an advance cycle for a fixed fixture set — not every
branch of the state machine, and not a live GitHub issue. Prefer extending an
existing advance/pre-merge/review harness with counters over inventing a new
orchestrator. If a single end-to-end advance function is too heavy, a
composed walk of the load-bearing stage entrypoints under one counter is
acceptable as long as the ceiling is one named constant and the test name
states it guards the advance path.

**Rationale:** Keeps the change shippable without a full integration harness
while still locking aggregate call growth.

### 7. Event schema compatibility

**Decision:** Add `by_wrapper` as an **additive** field on
`gh_metrics_summary` / summary type. Keep `schema_version` at `1` unless the
repo already has a versioning rule that requires a bump for additive event
fields; match the nearest precedent for additive event fields (e.g. optional
fields on other `RunEvent` types). Consumers that only read aggregate fields
keep working.

**Rationale:** Observability-only; avoid breaking readers of existing events.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Ceiling too tight → flaky CI when legitimate helper adds one call | Calibrate from measured baseline; require comment + deliberate constant edit when raising; prefer counting load-bearing deps only if needed for stability |
| Ceiling too loose → fails to catch memo removal | Prove with full-stack vs memo comparison in the same suite |
| Incomplete wrapper tagging → empty `by_wrapper` | Unit tests on collector + at least one integration-style record path for a known helper name; typed helpers opt in as they are touched or via a systematic pass |
| Double-counting retries | Record once per logical attempt policy consistent with today’s collector (record after each completed attempt as today); document if retries inflate counts |
| Scope creep into reconcile budgets | Explicit non-goal; tracked as #1002 |

## Migration Plan

1. Land collector + event field + unit tests for `by_wrapper` (no behavior change
   for stages).
2. Land pre-merge poll budget test calibrated against #816 memo path.
3. Land advance-walk budget test with its constant.
4. Regenerate `plugin/` only if mirrored `core/` sources change; run
   `openspec validate` and `npm run ci`.
5. Rollback: revert the change; no durable store migration (additive event field
   only).

## Open Questions

None that block specs or implementation. Exact ceiling integers are calibrated
at apply time from the green baseline, not fixed in this design document.
