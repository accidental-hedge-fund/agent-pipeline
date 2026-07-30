## Why

After a durable-loop supervisor/advance crash mid-pipeline (e.g. during `fix-2` with an open PR), resume reconciliation **repair-forwards** the ledger item from a dispatchable local state (`in_progress` / `pending` / `implemented`) to `pr_opened` solely because a PR is open and checks are green. The supervisor then never re-dispatches that item: `next_actions` advertises `advance`, but nothing consumes that action; the scheduler only admits `pending`, and the supervisor only re-drives existing `in_progress`. Siblings run instead, and the crashed item stays stranded until a human re-drives `/pipeline N` outside the loop. Observed on milestone `v1.29.0` run `loop-4d2de11c6c029a2f-s1` with **#574** (and earlier the same trap for **#601**).

## What Changes

- **Gate premature repair-forward out of local states when the live pipeline stage is mid-flight.** When the ledger item is in a non-remote-proving local state and verified `pipeline_stage` is mid-flight (closed set derived from `STAGES` in `core/scripts/types.ts`), reconciliation SHALL NOT classify open-PR alone as `ledger-behind` and SHALL NOT repair to `pr_opened`. Checks conclusion does not override this gate.
- **Required legacy heal:** already-stranded `pr_opened` + open PR + mid-flight stage is restored to `in_progress` with an audited history note (idempotent), then re-dispatched by the normal supervisor path.
- **Preserve true terminal catch-up and #511:** `merged` and `ready_label_present` win over the mid-flight gate; open PR + **non-mid-flight / null** stage still repairs to `pr_opened` (crash-after-PR-open path).
- **Resume re-dispatches mid-pipeline work** via existing `in_progress` re-drive through `pipeline/loop-execution@1` from live labels — not via non-consuming `next_actions.advance`.
- **Regression tests** at pure reconcile and supervisor execution-trace levels; prove bite without the fix.
- **OpenSpec deltas only** under this change during implementation (no direct living-spec edits until archive).
- **No auto-merge; no review-policy changes; no attempt to prevent host/process death.**

## Acceptance criteria

- [ ] Given ledger state `in_progress` and verified identity with open PR, checks `success`, and mid-flight `pipeline_stage` (e.g. `fix-2`), one reconciliation pass leaves the item **not** in `pr_opened` and still on a path the supervisor will re-dispatch (typically remains `in_progress`).
- [ ] Given ledger state `pending` and the same mid-flight open-PR identity, reconciliation does **not** repair-forward to stranded `pr_opened`; the item remains schedulable as `pending`.
- [ ] Given a local ledger state and verified identity with PR `merged`, reconciliation still repair-forwards to `merged`.
- [ ] Given a local ledger state and verified identity with open PR and `ready_label_present`, reconciliation still repair-forwards to `ready`.
- [ ] Given a local ledger state and open PR with non-mid-flight / null stage, reconciliation still repair-forwards to `pr_opened` (#511 compatibility).
- [ ] Given ledger state `pr_opened` with open PR and mid-flight stage, reconciliation heals to `in_progress` (audited, idempotent on repeated passes).
- [ ] After `--resume <run_id>` recovers a dead lock, a mid-pipeline item that remains or is healed to `in_progress` is re-dispatched through `pipeline/loop-execution@1` (execution call trace), not parked while a pending sibling runs alone.
- [ ] For mid-flight work, continuity does not depend solely on non-consuming `next_actions.advance` on `pr_opened`.
- [ ] Unit/pure tests cover mid-flight gate, heal, merged/ready catch-up, #511 non-mid-flight path, checks matrix, and supervisor sibling dispatch ordering; at least one mid-flight regression fails without the fix.
- [ ] `npm run ci` is green; OpenSpec change validates; living specs are not hand-edited during implementation.

## Capabilities

### New Capabilities

- _(none)_ — this is a correction to existing reconciliation + resume dispatch behavior, not a new surface.

### Modified Capabilities

- `durable-run-reconciliation`: mid-flight predicate from `STAGES`; gate local → `pr_opened`; heal stranded mid-flight `pr_opened` → `in_progress`; preserve `ready` / `merged` and #511 non-mid-flight catch-up.
- `durable-loop-supervisor`: after resume/reconciliation, mid-pipeline items that remain or are restored to `in_progress` SHALL be re-dispatched; supervisor MUST NOT strand them in favor of pending siblings.

## Impact

- `core/scripts/loop/precondition.ts` (or adjacent) — pure `isMidFlightPipelineStage` from `STAGES`.
- `core/scripts/loop/reconcile.ts` — `verifiedForwardTarget`, `classifyDrift`, reconcile heal branch.
- `core/scripts/loop/supervisor.ts` — verify existing `in_progress` re-dispatch; no frontier change for `pr_opened` required if heal works.
- `core/test/loop-reconcile.test.ts`, `core/test/loop-supervisor.test.ts` — gate, heal, #511 compat, execution-trace regressions.
- Delta specs only under `openspec/changes/loop-resume-mid-pipeline-repair-gate/`.
- Plugin mirror regen after `core/` edits.
