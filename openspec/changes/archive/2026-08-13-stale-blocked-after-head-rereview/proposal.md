## Why

After a legitimate pre-merge residual block, a later developer/fix commit can already answer the findings, but the next `pipeline single` / train / loop advance still STOPs on the leftover `pipeline:blocked` label. Live dogfood: **#691** / PR **#1022** during v1.38.0 ship — residual security block on `24c30ba`, then `05c3d4b0` (`fix: address pre-merge review findings`) landed; train left `blocked` and STOPped until an operator manually cleared the label. The failure was a **stale block**, not an open security residual. Intra-run self-heal in the SHA gate only clears when HEAD moves *while* `setBlocked` is written; it does not run on the **next** advance when the label is already present. Epic **#1028** landed a first cut (`stale-blocked-rereview` + `tryResumeStaleBlocked`); this change locks the full **#1025** contract so resume is correct for enter-path, rebase/`reviewed-sha` absent cases, and train/loop STOP timing.

## What Changes

- On **enter** of an already-`blocked` item at pre-merge / fix / review (including `pipeline single`, durable loop item advance, and train advance): if the latest blocking review/delta verdict has `reviewed-sha` **S** and PR HEAD **H** supersedes **S** with at least one non-pipeline-internal commit — or **S** is absent from PR history (rebase/squash) while **H** ≠ **S** — then:
  - `clearBlocked` for that stale cause
  - re-enter the stage path so delta review (or the existing conservative full re-review when HEAD moves mid-write) runs against **H**
  - do **not** invent an `--override` for security or residual keys solely because HEAD moved
- Pipeline-internal-only range (`S..H` all archive/sentinel commits under `isPipelineInternalCommit`) keeps today’s verdict reuse (#98): no forced re-review cascade and no silent clear solely for archive tip advance when residuals still need live-head re-evaluation under existing residual SHA-scope rules.
- If HEAD still **is** **S** and residuals remain, keep `blocked` / `needs-human`. True human-authority and unfixed security stay parked.
- `train --merge` / loop MUST NOT treat leftover pre-resume `blocked` as terminal STOP / hold-only until this resume has been attempted once on the current advance. If resume re-blocks on the **new** HEAD, STOP / park is correct.
- No auto-merge. No weakening the security auto-fix denylist. No override-from-commit-message.

## Capabilities

### New Capabilities

- (none) — epic #1028 already introduced living `stale-blocked-rereview`.

### Modified Capabilities

- `stale-blocked-rereview`: Lock the full #1025 enter-path contract: clear + re-review when HEAD supersedes blocking `reviewed-sha` with non-pipeline-internal commit(s); treat **S** absent from history (rebase) with **H** ≠ **S** as resume-eligible, not permanent keep; wire clear so advance continues into delta/conservative re-review before train STOP; keep HEAD==S and pipeline-internal-only behaviors; never invent security overrides.
- `review-sha-gating`: Align residual/stale-verdict language so enter-path resume and the SHA gate agree that a leftover `blocked` label alone does not grant authority after a non-internal HEAD advance past the blocking reviewed-sha (without weakening same-head residual holds or #98 approval reuse).

## Acceptance criteria

- [ ] Fixture / unit path: blocked on SHA S, then a non-pipeline-internal commit H lands → next advance clears `pipeline:blocked` and re-enters delta review (or equivalent re-review) against H; train/loop does not STOP solely on the pre-resume leftover `blocked` before that attempt.
- [ ] Fixture / unit path: blocked on S, HEAD still S with residual findings → stays blocked; train STOP or per-item hold after the resume check remains allowed.
- [ ] Fixture / unit path: only pipeline-internal commits after S → verdict reuse path (#98); no spurious re-review cascade from internal-only tip advance alone.
- [ ] Fixture / unit path: blocking `reviewed-sha` S is absent from PR history (rebase/squash) while HEAD H ≠ S → resume clears leftover block (or otherwise re-enters review at H) rather than permanent keep/STOP without an attempt.
- [ ] Resume does not invent `--override` for security or residual keys solely because HEAD moved; re-block on the new HEAD remains available when policy requires it.
- [ ] Unit tests use injected deps (no real network, git, or subprocess); after any `core/` edit, `plugin/` mirror is regenerated; `openspec validate stale-blocked-after-head-rereview` and `npm run ci` pass when implementation lands.

## Impact

- `core/scripts/stages/stale-blocked-rereview.ts` — enter-path resume classification (`tryResumeStaleBlocked`, stage eligibility).
- `core/scripts/pipeline-run.ts` (and any parallel blocked early-exit sites) — clear then continue into pre-merge / review before terminal STOP.
- Shared currency helper `resolveReviewedShaCurrency` in `pre-merge-sha-gate.ts` (or equivalent) for supersession vs internal-only vs unknown/rebase.
- Train / loop consumers of advance outcomes: no whole-train STOP before one resume attempt this advance when the block is stale.
- Tests: `core/test/stale-blocked-rereview.test.ts` plus advance/train wiring regressions as needed.
- Generated `plugin/` mirror when `core/` changes.
- Depends on: none. Independent of #1020 (scratch), #1021 (live sibling), #1023 (train frontiers), #1024 (continuous ship). Soft-enables ship usefulness of #1023. Part of epic **#1028**; composition/FRG **#1029**.
