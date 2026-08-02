## Context

FRG landed via #723 / change `release-mandatory-factory-reliability-gate` and is enforced by
`pipeline release` (lookup of `.agent-pipeline/frg/<version>/latest.json`). Layer B scoring lives
in `core/scripts/factory-reliability-gate.ts` (`computeFrgEvidence`, `runFactoryGate`). The first
release that shipped the gate (v1.29.1) used two clean comment-only pack items (#749/#750). With
zero classified blockers, `engine_class_rate` is `null` and surfaces as `n/a` — mathematically
“pass” under the current rate rule (`null` is treated as ≤ threshold) without ever exercising
OpenSpec archive, fix→re-review, capacity cascade, CI recovery, or the #787 autonomous recovery
controller.

Separately, `.github/workflows/auto-tag-release.yml` tags on subject + `core/package.json` version
match only; it never opens FRG evidence. A hand-authored `release: X.Y.Z — …` commit on `main` can
therefore tag without a representative (or any) FRG pass, even though `pipeline release` would
have refused.

Constraints:

1. Rigor-preserving: strengthen the gate; do not loosen K, max rate, or review coverage.
2. Threshold *values* (K=2, max engine-class rate 0.25) stay fixed in this issue — only become
   empirically reviewable via a trend ledger.
3. Layer A remains hermetic (no real network/git/subprocess). Layer B remains operator/CLI live.
4. Golden rule #4: FRG still never merges or creates tags as a side effect of scoring; auto-tag
   remains the tag owner but must consult FRG evidence first.
5. Reuse durable loop ledger + FRG evidence schema; do not invent a second advance engine.
6. Synthetic pack auto-close (#754) is out of scope (behavior retained as already specified).

## Goals / Non-Goals

**Goals:**

- Make release-eligible FRG pass require a **representative** pack composition (OpenSpec,
  fix→re-review, N≥2 contention, recovery classes, #787 controller paths).
- Define a **computable** engine-class rate whenever ≥1 item was processed (denominator fixed in
  spec/runbook).
- Append a **trend ledger** entry per Layer B evidence write for release-over-release review.
- Document bootstrap derivation of K=2 / 25%.
- Guard **auto-tag** with FRG pass validation for the version.
- Expose scenario observations through a **documented CLI** surface.
- Refresh Layer A waivers that cite closed issues (especially #730).

**Non-Goals:**

- Changing numeric K or max engine-class rate values.
- Synthetic pack auto-close redesign (#754).
- Auto-merge or unattended merge.
- Replacing product milestones with FRG work-lists.
- Full automated injection of every recovery fault without operator/fixture support (design may
  use labeled fixtures + observation CLI; hermetic Layer A covers classes that fit fake-deps).

## Decisions

### Decision 1 — Representative composition as release-eligibility criteria (not optional notes)

Release-eligible `pass: true` SHALL require a composition evidence block (on evidence JSON and/or
named scenarios) proving at least:

| Dimension | Minimum |
|-----------|---------|
| OpenSpec-bearing item | ≥1 pack item that carried a real OpenSpec change (archive/coherence path exercised) |
| Fix → re-review cycle | ≥1 pack item that hit a blocking finding, applied a fix, and re-entered review |
| Concurrency / capacity | Pack scored under concurrency with observed worktree contention satisfying N≥2 |
| Recovery / composition classes | Inventory below observed or hermetically covered + live-observed where Layer B required |
| #787 controller | Production recovery controller exercised via one-item **and** multi-item entry points |

Composition MAY be proven by a combination of: durable ledger projections (states, attempt
counts, blocker themes), structured observation records supplied via CLI, and fixed scenario
ids. Clean-only / comment-only packs that only satisfy K via trivial items SHALL fail
representative-composition validation even if throughput math passes.

**Rejected:** Soft “runbook recommendation” without driver enforcement (v1.29.1 already showed
operators take the easy pack). Threshold-only tightening without composition (still green on
trivial work).

### Decision 2 — Engine-class rate denominator = processed pack item count

When `scoreboard.item_count ≥ 1`:

```text
engine_class_rate = engine_class_count / item_count
```

where `engine_class_count` is the number of scored pack items whose projected blocker class is
`engine-class` (same taxonomy as today), and `item_count` is the number of items on the scored
pack work-list for that evidence run.

- Zero engine-class items → rate `0` (not `null`).
- `item_count === 0` → evidence is incomplete / non-release-eligible (existing empty pack
  refusal paths apply); rate may remain undefined only when no items exist to score.

**BREAKING vs current code:** today `rate = engine / (engine+product+human)` and `null` when
classified === 0. That definition made a fully clean trivial pack look like `n/a` “pass” and
made the rate incomparable across packs of different sizes. Item-count denominator always
yields a number when the pack has items and aligns with “what fraction of the pack hit factory
defects.”

**Rejected:** Keep classified-blocker denominator but coerce null→0 (still understates risk on
large clean packs mixed with silent failures; composition gate is the primary fix, but rate
semantics still need a stable denom for trends). Denominator = max(classified, 1) (distorts
rate when product/human holds dominate).

Product-class and human-authority counts remain on the scoreboard for honesty; they no longer
drive the rate denominator. Rate threshold comparison stays: strictly greater than
`max_engine_class_rate` fails the gate.

Recovery-exhaustion / terminal engine outcomes projected onto pack items continue to increment
`engine_class_count` via existing taxonomy (`workflow-engine-defect` and FRG engine-class
members). Aggregates by canonical reason code (success, exhaustion, resume count, elapsed) are
additional scoreboard/ledger fields — they feed the trend ledger and may contribute to
engine-class classification of the owning item, not a second competing rate.

### Decision 3 — Trend ledger as append-only JSONL under FRG root

On each durable Layer B evidence write (`writeFrgEvidence` / release path), append one line to:

```text
.agent-pipeline/frg/trend-ledger.jsonl
```

Each line is a self-contained JSON object: at least `version`, `run_id`, `loop_run_id`, `pass`,
`pack_id`, `created_at`, `ready_clean_count`, `item_count`, `engine_class_count`,
`engine_class_rate`, `thresholds` snapshot, and optional recovery aggregates / composition
flags. Append is best-effort fail-soft relative to primary evidence write only if write of
primary evidence already succeeded and ledger I/O fails — prefer: ledger append is part of the
write path and surfaces errors without deleting already-written immutable `evidence.json`
(mirror pack auto-close fail-soft pattern for ledger-only faults, or fail the driver if ledger
is required for release-eligible pass — **prefer fail-soft on ledger I/O after primary write**,
with stderr note, so a full disk does not orphan a valid pass; operators can rebuild ledger
from historical `evidence.json` trees).

**Rejected:** Checked-in-only markdown table (not machine-updated each run). Overwriting a single
`latest-trend.json` (loses history). GitHub Issues as ledger (noisy, not local-operator
friendly).

Runbook documents bootstrap: K=2 and max rate 0.25 were provisional values chosen for the first
mandatory gate (#723), not multi-release empirical optima; future tightening is a separate
issue after ≥N releases of ledger data.

### Decision 4 — Auto-tag FRG guard before tag create/push

After release-merge detection and version match, before annotated tag create/push,
`auto-tag-release.yml` SHALL:

1. Resolve FRG evidence for version `X.Y.Z` from the checked-out tree at the release merge
   commit: prefer `.agent-pipeline/frg/<X.Y.Z>/latest.json` (same path as `pipeline release`).
2. Validate with the same release-eligibility rules the driver/release path uses (parseable
   schema, `pass: true`, non-empty `run_id`, non-empty `loop_run_id`, matching `pack_id`,
   representative composition satisfied as encoded in evidence). Implementation MAY invoke a
   small Node entry (existing parse/validate functions) rather than re-expressing rules in bash.
3. On missing/invalid/`pass: false` → non-zero exit, **no tag**.
4. On pass → proceed to existing notes resolution + tag push.

Evidence must be **committed on the release merge** (or otherwise present in the tree at that
commit). Operators who only keep FRG artifacts local and uncommitted will fail auto-tag — that
is intentional (same durability bar as release PR attachment). Runbook states that release PRs
must include the FRG evidence paths (or a documented committed pointer) so main carries them.

**Rejected:** Trust release PR body text alone (forgeable, not schema-validated). Re-run live
FRG inside Actions (too heavy, non-hermetic). Optional “skip FRG” secret (creates silent
bypass).

Drift-guard tests extend `auto-tag-release-workflow.test.ts` (or sibling) so removing the FRG
check step fails CI.

### Decision 5 — Scenario observations via documented CLI flags / file

Extend `pipeline factory-gate` with a documented observation surface, for example:

```bash
pipeline factory-gate --for X.Y.Z --from-run <id> \
  --observations path/to/observations.json
# and/or repeated:
# --scenario id=status:detail[:observed=N]
```

Observation file schema: array of `{ id, status, detail, observed?, threshold? }` matching
existing `FrgScenarioOverride`. CLI parses into `scenarioOverrides` (already an internal dep
seam). Runbook documents the surface; usage without the file continues to score auto-derived
scenarios (throughput, taxonomy) and fails `not_observed` for the rest unless ledger projection
fills them.

**Rejected:** Operators importing TS modules and calling `runFactoryGate({ scenarioOverrides })`
as the supported path. Silent default of “all pass” helper in production CLI
(`frgRequiredObservationOverrides` remains test-only).

### Decision 6 — Recovery / composition inventory (stable scenario or composition flags)

Expand the named inventory (superset of existing pack ids) to include release-eligible
composition dimensions and recovery classes. Prefer **stable scenario ids** (or composition
flag keys) so scoreboard and tests stay nameable:

| Id / flag | Intent |
|-----------|--------|
| existing pack ids | retained |
| `openspec-bearing-item` (composition) | ≥1 real OpenSpec change item |
| `fix-rereview-cycle` (composition) | ≥1 blocking finding → fix → re-review |
| `concurrency-contention` (composition) | N≥2 worktree contention observed |
| `managed-worktree-dirt` | missing/dirty managed worktree recovery |
| `process-restart-hydration` | process death + fresh-process resume |
| `forge-http-5xx-backoff` | forge 5xx with bounded backoff |
| `ci-pending-red-recovery` | pending/red CI bounded recovery |
| `same-head-noop-reentry` | same-HEAD no-op re-entry |
| `capacity-live-run-coexistence` | concurrent capacity pressure + live-run coexistence |
| `recovery-controller-one-item` | #787 path, single-item entry |
| `recovery-controller-multi-item` | #787 path, multi-item entry |

Exact id spelling is implementer’s choice within kebab-case stability; specs refer to the
**requirement** (what is exercised), not a frozen list that blocks reasonable naming.

Release-eligible pass additionally requires: zero false product-judgment / `human_authority`
projections for injected recoverable classes, and bounded convergence or typed exhaustion that
feeds engine-class scoring for each injected class.

### Decision 7 — Waiver refresh for closed #730

`release-plan-row` Layer A currently waives to #730 (CLOSED). Implementation either:

1. Adds a biting hermetic test (or drift-guard) for plan-row / tag-path honesty, **or**
2. Points the waiver at a still-open tracking issue if a hermetic test is not yet feasible.

Closed-issue citations in the waiver table are forbidden after this change. Prefer (1) for
`release-plan-row` given auto-tag FRG guard lands in the same change (related honesty surface).

### Decision 8 — Retire #749/#750 as non-representative

Runbook marks clean composition items #749/#750 as **retired fixtures** (not valid alone for
release-eligible FRG). Operator migration: replace with representative pack issues (OpenSpec +
review-cycle + recovery fixtures). Closing the GitHub issues is process work during/after
implementation; specs require the gate refuse clean-only packs regardless of issue state.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Representative pack is slower / harder to run every release | Fixed pack still dedicated (not full milestone); composition is minimum dimensions, not “entire product backlog”; K stays 2 |
| Evidence must be committed for auto-tag | Runbook + release path already attach FRG; add explicit “commit latest.json / evidence under repo or release tree” procedure; fail closed is correct |
| Item-count rate is stricter on large packs with incidental engine defects | Desired; composition + rate both enforce honesty; thresholds unchanged this issue |
| Observation CLI can be gamed with fake `pass` overrides | Numeric capacity rules already re-validate; composition dimensions should prefer ledger-derived proof where possible; overrides remain subject to `enforceRequiredScenarioCriteria` |
| Trend ledger disk/IO failure | Fail-soft after primary evidence write; rebuild from evidence trees documented |
| Over-specified recovery injection automation | Specs require exercise and observation, not a full chaos framework in v1 of this change |

## Migration Plan

1. Land schema/scoring/CLI/runbook/tests + auto-tag guard behind normal PR CI.
2. Update FRG runbook: representative pack procedure, observation CLI, rate formula, trend
   ledger path, bootstrap threshold note, retired #749/#750.
3. Next release: operators run representative pack; commit FRG evidence with release PR so
   auto-tag sees it on merge.
4. Close or label-retire #749/#750 when replacement fixtures exist.
5. Rollback: revert PR; prior FRG evidence remains readable; auto-tag loses FRG check only if
   workflow reverted (acceptable temporary).

## Open Questions

1. **Committed evidence layout on release PR:** require `.agent-pipeline/frg/` in the release
   commit tree vs. upload artifact + checkout from Actions artifact store? Default design:
   tree-committed `latest.json` (matches current release lookup). Artifact-only can be a
   follow-on if operators object to committing under `.agent-pipeline/`.
2. **Whether composition flags are first-class scenario ids vs. a nested `composition` object**
   on evidence — implementer may choose either as long as validation and tests are machine-checkable.
3. **Minimum recovery aggregate schema** (exact field names for elapsed/reason-code maps) — lock
   in implementation with schema_version bump if needed (prefer additive fields on schema v1
   if parse validation allows optional maps).
