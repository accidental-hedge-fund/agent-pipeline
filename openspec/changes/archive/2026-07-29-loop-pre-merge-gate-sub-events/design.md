## Context

Durable loop already publishes:

| Kind | When |
|------|------|
| `loop_item_advance_linked` | Advance run store confirmed; carries `item_id`, `pipeline_run_id`, absolute `events` |
| `loop_item_advance_finished` | Dispatch terminal; carries outcome |

Between those two points the advance run may spend a long time in pre-merge.
Advance `events.jsonl` already records material facts:

- `gate_result` — e.g. `gate: "openspec-archive"`, `result: pass|fail|skipped`
- CI wait / pass / fail outcomes (via `gate_result` and/or `blocker_set` / stage outcome)
- `review_verdict` — delta recheck
- pre-merge auto-fix path outcomes
- `blocker_set` / terminal stage outcomes

The loop stream does **not** currently mirror any of those, so loop-only follow
looks hung. #611 owns **stage-level** progress (planning → … → ready-to-deploy).
This change owns **gate sub-steps inside pre-merge** (and uses a schema that
does not fight #611).

Related:

| Issue | Role |
|-------|------|
| #611 | Stage progress surface / shared progress family |
| #682 | **This change** — pre-merge gate sub-events on loop stream |
| #684 | Interim dual-follow packaging until loop stream is sufficient |

Dogfood: `loop-e640995c20b8f046` / advance `554-2026-07-29T17-23-40-332Z`.

## Goals / Non-Goals

**Goals:**

- Append material pre-merge gate progress onto the **loop** durable event trail
  while advance linkage is active.
- Use **one progress schema family** that #611 can also use for stages (typed
  payloads under a shared kind).
- Join every progress event to `item_id` + `pipeline_run_id` (+ advance `events`
  path when known).
- Suppress pure CI poll spam (no per-tick “waiting” flood).
- Unit-test emit mapping with injected fake advance event streams.
- Document material facets in host skill orchestration.

**Non-Goals:**

- Changing pre-merge gate algorithms, review policy, auto-fix allowlist, or
  archive fail-closed behavior.
- Implementing the full #611 stage table / `--audit --follow` stage column
  (only reserve the shared envelope).
- Making advance-stream follow mandatory forever (#684 is interim packaging;
  this change makes loop-only follow **sufficient for pre-merge gate outcomes**).
- Auto-merge or any merge-path change.
- Cross-host event fan-out beyond the existing local loop store.

## Decisions

### Decision 1: Shared `loop_item_progress` kind with typed domain/step payloads

**Choice:** Emit a single loop event kind:

```text
kind: "loop_item_progress"
data: {
  item_id: string,
  pipeline_run_id: string,
  events?: string,           // absolute advance events.jsonl when known
  domain: "pre_merge" | "stage",
  step: string,              // see catalog below
  status: string,            // see catalog below
  detail?: object            // step-specific optional fields
}
```

**Pre-merge catalog (this issue):**

| `domain` | `step` | material `status` values |
|----------|--------|---------------------------|
| `pre_merge` | `ci` | `waiting`, `pass`, `fail` |
| `pre_merge` | `openspec_archive` | `pass`, `skipped`, `fail` |
| `pre_merge` | `delta_review` | `started`, `approve`, `needs_attention` |
| `pre_merge` | `autofix` | `attempted`, `success`, `exhausted` |
| `pre_merge` | `terminal` | `blocked`, `advanced` |

`detail` MAY include:

- CI: `classification` (when available, e.g. failing-check class / reason class)
- Delta: `blocking_count` on `needs_attention`
- Terminal: `reason_class` (stable class token when available) and/or short reason
- Always optional: `source_advance_type` (e.g. `gate_result`) for audit join

**Why:** Issue #682 explicitly asks for one schema family with #611. Dedicated
kinds per facet (`loop_item_gate_ci`, …) would fork the progress model and force
hosts to special-case two shapes.

**Alternative considered:** Mirror raw advance lines byte-for-byte into the loop
stream — rejected; floods the loop with harness noise and poll spam.

**Alternative considered:** Callback hooks from pre-merge into the loop
supervisor — rejected for v1; couples advance stage code to loop and complicates
dispatch-as-subprocess. Prefer read-side mirror of advance `events.jsonl`.

**#611 coordination:** Stage progress SHOULD use `domain: "stage"` with
`step` = pipeline stage label and `status` = enter/complete (or equivalent).
This change does **not** require #611 to ship first; it only reserves the
envelope. If #611 lands a different shared name first, implementers SHALL adapt
to that single family rather than keeping two permanent models (rename + one
migration is fine; dual long-lived models are not).

### Decision 2: Thin read-side mirror during linked advance wait

**Choice:** After `loop_item_advance_linked` and until
`loop_item_advance_finished` (or child exit), a supervisor helper:

1. Opens / polls the absolute advance `events` path from linkage.
2. Scans newly appended advance events.
3. Maps material ones → at most one loop `loop_item_progress` per logical
   outcome transition (see Decision 3).
4. Writes via existing loop `appendEvent` (same durable trail, no second ledger).

Inject seams (`readAdvanceEventsSince`, `appendLoopEvent`, clock) for unit tests.

**Why:** Matches issue wording (“supervisor or a thin mirror”), reuses existing
advance instrumentation (`gate_result`, `review_verdict`, …), and works whether
dispatch is in-process or subprocess.

**Alternative considered:** Only emit at terminal finish by replaying the whole
advance file — rejected; hosts still see silence during multi-minute CI wait.

### Decision 3: Materiality and spam control

**Choice:**

- **CI waiting:** emit `status: waiting` at most once per continuous wait stretch
  (first observation of pending/waiting CI for this linked run, or first after a
  non-waiting status). Do **not** re-emit on every poll/tick with identical
  waiting state.
- **CI pass/fail:** emit once when a definitive pass or fail (or blocked-for-CI)
  outcome is observed.
- **OpenSpec archive:** emit once per `gate_result` with `gate: "openspec-archive"`
  (pass / skipped / fail).
- **Delta review:** emit `started` when a delta review begins (if advance emits
  a start signal; else on first delta `review_verdict`); emit `approve` or
  `needs_attention` on the verdict (include `blocking_count` when needs-attention).
- **Auto-fix:** emit `attempted` when the auto-fix path starts; `success` when
  fix lands and re-review is clean; `exhausted` when the bound is spent / still
  blocking.
- **Terminal:** emit when pre-merge ends for this entry with `blocked` (reason
  class when available) or `advanced` (left pre-merge toward later stage /
  ready-to-deploy path).

Idempotency: track last emitted `(step, status, fingerprint)` per
`(item_id, pipeline_run_id)` so replaying the same advance tail does not
duplicate loop lines.

### Decision 4: Join keys always present; advance path preferred

**Choice:** Every `loop_item_progress` MUST include `item_id` and
`pipeline_run_id` from the active linkage. When linkage carried `events`,
copy that absolute path onto progress payloads (hosts need not re-join only
via prior events, though they may).

### Decision 5: Host docs — loop sufficient for gate outcomes; advance optional for fidelity

**Choice:** Update `loop-skill-orchestration` material list to include
`loop_item_progress` (pre-merge facets). Keep optional advance follow for full
stage/harness fidelity and for hosts that want raw detail. Do not claim that
loop-only follow covers every advance harness line.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Mapping lags if pre-merge emits new gate names | Centralize mapping table; unit-test known gates; unknown material gates log once / skip rather than crash |
| Duplicate events on supervisor crash/restart | Fingerprint last-emitted outcomes per linkage; start mirror from advance file offset/seq when available |
| #611 chooses a different envelope name | Spec allows adapting to a single shared family; do not permanently dual-model |
| Mirror latency (poll interval) | Prefer short poll or `fs.watch`/tail; acceptance is “during pre-merge”, not sub-second |
| Over-mirroring becomes spam | Decision 3 materiality rules + tests for no per-tick waiting |

## Migration Plan

1. Land OpenSpec change (this proposal/design/specs/tasks).
2. Implement mirror + tests; update host skills; regenerate `plugin/` if needed.
3. No data migration — additive event kinds only; old loop runs simply lack progress lines.
4. Rollback: stop mirroring; hosts fall back to advance follow (#684) — no durable
   contract broken for ledger state machines.

## Open Questions

1. Exact advance-event → step mapping for CI (whether CI uses `gate_result` with a
   stable `gate` name today, or only waiting outcomes / `blocker_set`) — resolve
   by reading live advance events from dogfood / unit fixtures during
   implementation; do not invent `gh` field names.
2. Whether #611 has already reserved a progress kind name on a not-yet-merged
   branch — before coding, grep living + active changes for `loop_item_progress`
   / stage progress kinds and converge on one name.
