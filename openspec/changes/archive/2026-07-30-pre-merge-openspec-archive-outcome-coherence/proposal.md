## Why

Pre-merge can emit contradictory OpenSpec archive outcomes in a single pass: `openspec-archive` reports `skipped`/`no-candidates` (or even `pass` naming change ids) and then the same pre-merge run blocks with `openspec-invalid` because those ids remain active on the PR. Observed on #626 (PR #713: skip→block) and #675 (PR #721: multi-id pass while only one change was archived, then skip→block). Operators and the durable loop cannot trust the gate signal, burn human-intervention paths, and get stuck recovering after hold/resume.

## What Changes

- Unify the **active OpenSpec change set** used for archive candidate discovery and the post-archive “still active” guard so they cannot disagree for the same PR head.
- Make archive outcomes **fail closed and coherent**:
  - `skipped` / `no-candidates` only when the shared active set is empty.
  - Non-empty active set → attempt archive for every id (or block with a named error) — never skip then block on the same ids.
  - `pass` reason lists **only** change ids actually moved under `openspec/changes/archive/` in that archive action; partial multi-archive must not claim success for the full candidate list.
- When blocking on residual active changes, keep clear remediation text that names every still-active id and the operator action (`openspec archive <id>` + push).
- Add regression tests for both fingerprints (single active + false skip; multi active / foreign-stacked + partial archive false pass).

## Acceptance Criteria

Observable, falsifiable outcomes that make this issue done:

- [ ] For a fixture PR/worktree with one active change under `openspec/changes/<id>/`, a pre-merge archive evaluation does **not** emit `gate_result` `openspec-archive` / `skipped` / `no-candidates` and then block the same pass because that same id is still active.
- [ ] For a fixture with two active changes where only one is successfully archived, the archive gate does **not** record `pass` with a reason listing both ids; the residual active id either remains a candidate/block or is named in a single coherent failure — never dual-id success then later `openspec-invalid` for the leftover.
- [ ] A foreign/stacked active change present on the PR head (e.g. brought in by merging another branch) is in the **same** active-change set used for archive attempts and for the still-active consistency check.
- [ ] When the shared active set is non-empty, the gate either archives successfully (and records only truly archived ids on pass) or blocks with a named reason that includes every still-active change id and the remedy `openspec archive <id>` (plus push), without a prior successful/skipped “no candidates” result for that same head evaluation.
- [ ] Regression tests cover both fixtures above and **fail** against current dual-outcome behavior (or a synthetic reproduction of it) before the fix lands.
- [ ] Existing valid paths remain: true empty active set still skips with `no-candidates`; real archive failures still block with `openspec-invalid` and CLI/output detail; active OpenSpec changes still block `ready-to-deploy` when unarchived.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `openspec-integration`: Strengthen pre-merge archive decision + post-archive active-change guard so they share one source of truth for active change ids, forbid skip/pass-then-block dual outcomes, and require honest pass reasons for multi-archive (including stacked/foreign active changes).

## Impact

- **Code:** `core/scripts/stages/pre_merge.ts` (`maybeArchiveOpenspec`, `enforceOpenspecActiveChangeGuard`), possibly shared helpers in `core/scripts/openspec.ts` (candidate/unarchived id derivation).
- **Tests:** `core/test/` pre-merge archive / active-change guard coverage (new regression fixtures).
- **Events / operators:** `gate_result` for `openspec-archive` and `blocker_set` reasons become truthful and actionable; loop pre-merge sub-events mirror that truth.
- **Out of scope:** implementers forgetting to archive (still product-required); loop `pr_opened` stranding after block (#712); relaxing the rule that active OpenSpec changes block ready-to-deploy.
