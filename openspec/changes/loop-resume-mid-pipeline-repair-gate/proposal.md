## Why

After a durable-loop supervisor/advance crash mid-pipeline (e.g. during `fix-2` with an open PR), resume reconciliation **repair-forwards** the ledger item from a dispatchable local state (`in_progress` / `pending` / `implemented`) to `pr_opened` solely because a PR is open and checks are green. The supervisor then never re-dispatches that item: `next_actions` advertises `advance`, but nothing consumes that action; the scheduler only admits `pending`, and the supervisor only re-drives existing `in_progress`. Siblings run instead, and the crashed item stays stranded until a human re-drives `/pipeline N` outside the loop. Observed on milestone `v1.29.0` run `loop-4d2de11c6c029a2f-s1` with **#574** (and earlier the same trap for **#601**).

## What Changes

- **Gate premature repair-forward out of local states when the live pipeline stage is still mid-flight.** When the ledger item is in a non-remote-proving state (`pending`, `in_progress`, `implemented`, and other local states) and the verified `LoopExternalIdentity.pipeline_stage` indicates active mid-pipeline work (`implementing`, `review-1` / `review-2`, `fix-1` / `fix-2`, `pre-merge`, `eval-gate`, `shipcheck-gate`, planning stages, etc.), reconciliation SHALL **not** classify the item as `ledger-behind` and SHALL **not** repair it to `pr_opened` merely because an open PR (with or without green checks) exists.
- **Preserve true terminal catch-up.** Repair-forward to `ready` (ready-to-deploy label present) and to `merged` (PR merged) from local states remains allowed and audited — those are still externally proven terminal-ish advances, not mid-flight work.
- **Resume keeps mid-pipeline items dispatchable.** After supervisor resume (including dead-holder lock recovery), an item that was `in_progress` and is still mid-pipeline on GitHub remains `in_progress` (or is otherwise re-admitted to a dispatch path) and is re-driven through `pipeline/loop-execution@1` from its live stage labels.
- **Same rule for `pending` + open PR mid-pipeline.** A `pending` item whose live stage is already mid-pipeline SHALL NOT be jumped to stranded `pr_opened` (#601-class); it stays on a path the scheduler can admit (`pending` → start → `in_progress` → dispatch).
- **`next_actions.advance` is not a dead advertisement for this class of item.** Either the item never enters the non-consuming `pr_opened` + `advance` combination for mid-flight work, or any residual `pr_opened` + mid-flight case is re-entered into a real dispatch path. No silent dead-end.
- **Regression tests** prove: ledger `in_progress` + open PR + checks success + `pipeline_stage: fix-2` (or similar) remains dispatchable after reconcile; a sibling `pending` is not selected *in place of* the stranded item solely because reconcile demoted it; the regression fails without the fix.
- **No auto-merge; no review-policy changes; no attempt to prevent host/process death.**

## Acceptance criteria

- [ ] Given ledger state `in_progress` and verified identity with open PR, checks `success`, and mid-flight `pipeline_stage` (e.g. `fix-2`), one reconciliation pass leaves the item **not** in `pr_opened` and still on a path the supervisor will re-dispatch (typically remains `in_progress`).
- [ ] Given ledger state `pending` and the same mid-flight open-PR identity, reconciliation does **not** repair-forward to stranded `pr_opened`; the item remains schedulable as `pending` (or is otherwise driven) so the loop can continue it.
- [ ] Given a local ledger state and verified identity with PR `merged`, reconciliation still repair-forwards to `merged` (true catch-up preserved).
- [ ] Given a local ledger state and verified identity with open PR and `ready_label_present`, reconciliation still repair-forwards to `ready` (true catch-up preserved).
- [ ] After `--resume <run_id>` recovers a dead lock and re-attaches the supervisor, a mid-pipeline item that was `in_progress` at crash is re-dispatched (or equivalently driven) so advance continues from the issue's current `pipeline:*` stage — not parked forever while siblings run.
- [ ] For mid-flight work, the loop does not leave the only advertised action as non-consuming `next_actions.advance` on `pr_opened` while the scheduler only admits `pending` and the supervisor only re-drives `in_progress`.
- [ ] Unit/pure tests with injected observe + store seams cover the `in_progress` + open PR + green checks + mid-flight stage case (and the merged / ready catch-up cases); at least one regression fails against today's unguarded `verifiedForwardTarget` / `classifyDrift` behavior without the fix.
- [ ] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync, install smoke, `openspec validate --all`).

## Capabilities

### New Capabilities

- _(none)_ — this is a correction to existing reconciliation + resume dispatch behavior, not a new surface.

### Modified Capabilities

- `durable-run-reconciliation`: forward repair and drift classification for local ledger states MUST consult live `pipeline_stage` and MUST NOT repair mid-flight work to `pr_opened` on open-PR alone; true `ready` / `merged` catch-up remains; next-action computation MUST NOT strand mid-flight work behind a non-consuming `advance`.
- `durable-loop-supervisor`: after resume/reconciliation, mid-pipeline items that remain (or are restored to) a dispatchable local state SHALL be re-dispatched; the supervisor MUST NOT treat a mid-flight open PR as reason to skip the item in favor of unrelated pending siblings.

## Impact

- `core/scripts/loop/reconcile.ts` — `verifiedForwardTarget`, `classifyDrift`, and possibly `computeNextAction` / the reconcile repair branch; must use `LoopExternalIdentity.pipeline_stage` (already observed) to gate local → `pr_opened` repair.
- `core/scripts/loop/supervisor.ts` — resume/cycle selection already re-drives `in_progress`; verify it still does after the gate, and add any residual path for already-stranded `pr_opened` + mid-flight if the design chooses a heal path.
- `core/scripts/loop/types.ts` — no schema break expected; may document mid-flight stage set shared with precondition helpers.
- `core/test/loop-reconcile.test.ts` (and supervisor tests if heal/re-dispatch is covered there) — extend #511 local+PR cases so mid-flight stages do not repair to `pr_opened`; keep merged/ready catch-up; prove regression bites.
- Living specs: `openspec/specs/durable-run-reconciliation/`, `openspec/specs/durable-loop-supervisor/`.
- No plugin hand-edit beyond mirror regen if `core/` changes at implement time; this proposal step is OpenSpec-only.
