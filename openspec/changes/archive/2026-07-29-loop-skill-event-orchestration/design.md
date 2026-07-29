## Context

`pipeline:loop` is a durable multi-item supervisor. It can run for many minutes to
hours while dispatching items through the normal advance state machine. Loop events
already land under the Pipeline loop state home:

```text
<state-home>/runs/<run_id>/events.jsonl
```

where `<state-home>` resolves via `AGENT_PIPELINE_STATE_HOME` → legacy
`PIPELINE_STATE_HOME` → `$XDG_STATE_HOME/agent-pipeline/loop` →
`~/.local/state/agent-pipeline/loop`.

Known loop event kinds already emitted by the in-repo supervisor include (non-
exhaustive): `loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`,
`loop_item_paused` / `loop_item_waiting` / `loop_item_resumed`,
`loop_item_abandoned`, `loop_item_skipped`, `loop_item_precondition_excluded`,
`loop_item_hold_cleared`, `loop_schedule_evaluated`, `loop_reconciled`,
`loop_merge_barrier_cleared`, `loop_recovery_attempt`, `loop_replan_requested`,
`loop_run_stopped`, `loop_run_superseded`.

Despite that, packaging classifies `loop` as `fast: true` in `scripts/build.mjs`.
`renderClaudeCommand` therefore injects:

> Run synchronously (completes in seconds). No background process or Monitor needed.

That line ships into `plugin/pipeline/commands/pipeline:loop.md` and the installed
Claude command surface. Harnesses that obey it never arm a Monitor, never stream
events, and never Push material transitions — the opposite of `/pipeline N`
advance orchestration in host `SKILL.md` §4.

Related cluster (out of scope here, best landed around this packaging fix):

| Issue | Topic |
|-------|--------|
| #665 | Early handoff (`run_id` + events path published early) |
| #666 | Loop logs follow CLI |
| #667 | Dispatch → advance `run_id` linkage |
| #668 | **This change** — skill/command orchestration rewrite |

Suggested order remains handoff → logs follow → dispatch linkage → skill final;
this change may land **before** those CLIs if it documents an interim follow path.

## Goals / Non-Goals

**Goals:**

- Stop claiming seconds-only duration or forbidding Monitor for multi-item
  drive/resume of `pipeline:loop`.
- Give harnesses an explicit orchestration protocol aligned with single-issue
  advance: handoff → follow → notify material kinds → stop → summarize.
- Keep `--audit` (read-only) synchronous; do not force Monitor for pure audit.
- Provide interim follow instructions against state-home `events.jsonl` so the
  skill never depends on a missing CLI and never forbids monitoring.
- Drift-guard the forbidden packaging phrases for the `loop` operation.
- Keep plugin/host mirrors in sync via the existing build path.

**Non-Goals:**

- Implementing or requiring early handoff stdout shape beyond documenting what
  harnesses should parse when available (#665).
- Implementing `logs --follow` for loop runs (#666).
- Linking dispatch item advance `run_id` into loop events (#667).
- Changing supervisor scheduling, stop conditions, recovery, or event schema.
- Changing orchestration guidance for true-fast commands (`status`, `doctor`,
  `cleanup`, etc.) — they remain seconds-long and Monitor-free.
- Auto-merge or any merge-path change.

## Decisions

### Decision 1: Reclassify `loop` as long-running in `OPERATION_SURFACE`

**Choice:** Set `fast: false` for the `loop` operation (or replace the boolean with
an explicit orchestration mode that is not the shared “seconds / no Monitor”
template). Keep `inRepoLoop: true` and the existing in-repo supervisor prose.

**Why:** The root generator is the single source of truth for Claude command
shims. Leaving `fast: true` will reintroduce the false guidance on every
`build.mjs` regeneration.

**Alternative considered:** Hand-edit only `plugin/pipeline/commands/pipeline:loop.md`
— rejected; `plugin/` is generated and the next build would overwrite the fix.

**Alternative considered:** Special-case only the prose while leaving `fast: true`
for some other consumer — rejected unless a second consumer of `fast` is found that
needs the flag; today `fast` only selects the orchNote string.

### Decision 2: Loop-specific orchestration note, not the generic non-fast template

**Choice:** When rendering the `loop` / `inRepoLoop` command, emit a short
orchestration note that:

1. States multi-item drive/resume is long-running (minutes to hours).
2. Instructs the harness to obtain `run_id` and the loop events path early (from
   command handoff when available, else from printed JSON / state-home layout).
3. Instructs following the loop event stream (Monitor / persistent tail).
4. Points to host SKILL.md for the full material-event and summary protocol.
5. Notes that `--audit` remains synchronous and Monitor-free.

Do **not** reuse the generic non-fast string alone (“See the pipeline SKILL.md for
orchestration instructions when this command runs a model harness”) without
loop-specific run_id/events path language — that string is about model harnesses,
not durable loop supervision.

### Decision 3: Document interim file follow until loop logs CLI ships

**Choice:** Skill/command docs SHALL document following:

```text
<state-home>/runs/<run_id>/events.jsonl
```

via a persistent Monitor/`tail -F` (or host-equivalent) as the interim path.
When #666 lands, prefer the CLI (`pipeline logs … --events --follow` or the loop-
scoped equivalent) but keep the file path as a documented fallback.

**Why:** Issue #668 acceptance requires monitoring guidance without shipping a CLI
that does not exist. Forbidding Monitor until #666 is worse than an interim path.

### Decision 4: Material notification kinds (coarse, bounded)

**Choice:** Docs SHALL list these kinds as **must notify** (Push / harness
notification):

- `loop_item_started`
- `loop_item_transitioned`
- `loop_item_blocked`
- `loop_run_stopped`

and **should notify** when present (not spam if high-frequency):

- `loop_schedule_evaluated` (only on decision change, not every identical poll)
- `loop_reconciled` / `loop_merge_barrier_cleared`
- `loop_item_paused` / `loop_item_waiting` / `loop_item_resumed`
- `loop_item_abandoned` / `loop_item_skipped` / `loop_item_precondition_excluded`
- `loop_recovery_attempt`
- `loop_run_superseded`

Suppress pure heartbeat noise and repeated identical schedule evaluations in the
same burst — same spirit as single-issue suppression of `pre_merge.advancePolling`.

Optional: when an active item’s advance `run_id` is published (depends on #667),
follow that item’s `.agent-pipeline/runs/<advance-run-id>/events.jsonl` with the
existing single-issue material kinds (`stage_start`, `stage_complete`,
`review_verdict`, `blocker_set`, `run_complete`, …). Document as optional “when
published,” not required for this issue.

### Decision 5: Where the full protocol lives

**Choice:**

- **Thin** orchestration note in generated `pipeline:loop.md` (always visible at
  command invoke).
- **Full** protocol in `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` (and the
  plugin SKILL mirror via existing build), as a dedicated loop subsection parallel
  to single-issue §4 — not buried only in README.

`--audit` stays listed under modes that do not need long-running orchestration.

### Decision 6: Drift-guard placement

**Choice:** Extend `core/test/namespaced-commands.test.ts` (existing loop wrapper
regressions live there, e.g. 7.5b3) with assertions that:

1. `OPERATION_SURFACE` entry for `loop` is not classified as the shared fast
   template (or `renderClaudeCommand(loop)` does not contain the forbidden
   phrases).
2. Rendered Claude loop command content does **not** match
   `/completes in seconds/i` or `/no background process or monitor needed/i`.
3. Rendered Claude loop command content **does** mention long-running or
   Monitor/follow/events in positive terms.

Optional install/build check can re-scan generated `plugin/pipeline/commands/pipeline:loop.md`
for the same forbidden phrases; unit-level render assertion is the minimum bar.

### Decision 7: Scope of `pipeline-loop-facade` delta

**Choice:** Add (or modify) requirements so the facade’s host packaging describes
durable runs as long-running and requires event-following orchestration. Do not
rewrite the facade’s execution, preflight, or merge-refusal requirements.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Harnesses block the session waiting for full loop completion after reclassification | Orchestration docs parallel advance: start + follow, do not require a single foreground bash with multi-hour timeout |
| Interim `tail -F` on state-home is host-specific / path-dependent | Document state-home resolution order; prefer CLI when #666 lands |
| Early handoff not yet available (#665) | Non-blocking start + race-safe state-home discovery (new published run dir or lock held by supervisor pid); resume arg / early handoff preferred; terminal JSON is final summary only |
| Notification spam on schedule/reconcile | Material vs suppress lists; suppress identical burst repeats |
| Operators confuse `--audit` with drive | Explicitly keep audit synchronous and Monitor-free |
| Spec overreaches into engine event schema | Spec mandates docs + packaging + drift-guard only; does not change event emitters |

## Migration plan

1. Spec/design/tasks land (this change artifacts).
2. Implementation flips `loop` packaging + SKILL prose + drift-guard + `build.mjs`
   regenerate.
3. When #665/#666/#667 land, tighten skill text to prefer CLI handoff/follow without
   removing the file-path fallback unless the CLI is universal.

## Open questions

- Exact early-handoff JSON field names (#665) — document placeholders (`run_id`,
  `events_path`) until that issue freezes the shape; do not invent a permanent CLI
  flag in this change.
- Whether Codex agent YAML needs a longer default prompt body for loop (today it is
  thin); host SKILL.md remains the primary protocol surface for Codex.
