## Why

After #181, a **definitively red** pre-merge CI check hard-blocks to `needs-human` (after at most one rebase). That stopped the archive/poll spin loop, but it made pre-merge the dominant autonomy cliff: green local test-gate + green GitHub CI on the **reviewed code SHA**, then a new head (often OpenSpec archive) fails CI and the run dies without re-run, flake classification, or a bounded test-fix.

Dogfood evidence (#554 / PR #678, 2026-07-29): implement + fix-1 and GitHub CI were green on code commits; review approved; pre-merge archived OpenSpec only; CI on the archive head failed with a Node test-runner IPC deserialize error (infra/flake signature). The pipeline set `blocked` / `reason: "CI failed"` with a comment listing only `test: fail` — no re-run, no classification, no pre-archive green evidence.

Related closed work: #181 (block instead of spin), #281 (zero-run archive recovery). This change is the **missing middle**: definitive red checks that are recoverable without infinite poll.

## What Changes

- **Classify definitive CI failures** into at least `infra` / `flake`, `assertion` / `product`, and `unknown` before choosing recovery or escalate.
- **Bounded recovery budget per head SHA** (durable across process restart; must not reintroduce #181 spin):
  1. Keep existing optional one-shot rebase if never rebased.
  2. **infra/flake:** auto re-run failed workflow/check **once**; return `waiting` for CI; still red after re-run → escalate.
  3. **archive-only head** (diff from pre-archive SHA touches only `openspec/**`) **and** pre-archive SHA had successful checks: prefer re-run / close+reopen-family recovery over immediate hard block on first red (extend #281 from “zero runs” to “failed runs that look infra”); surface pre-archive green evidence on the run and in any eventual block comment.
  4. **Optional (config-capped) assertion path:** at most one implementer surgical-fix attempt + push + re-wait CI; exhaustion → escalate. Durable “auto-fix attempted” marker required so this cannot loop.
  5. Only after budget exhausted: `setBlocked` with a distinct blocker kind (e.g. `ci-exhausted`) and an actionable recipe — not a bare generic `needs-human` with check names only.
- **Richer block comments:** failing check name(s) + conclusion, job/run URL(s), head SHA (and pre-archive green SHA when applicable), short log excerpt, classification used, and exact next operator steps.
- **Non-goals:** do not waive required CI forever; do not re-archive / re-poll forever (#181); do not conflate with merge-queue repair (#675) — this is the **pre-merge advance CI gate** only. `ci_mode: local` behavior is unchanged by this change except that any local-mode block reasons remain as today.

## Capabilities

### New Capabilities

- _(none)_ — behavior extends the existing pre-merge CI gate and blocker-recipe surface.

### Modified Capabilities

- `pre-merge-ci-gate`: Replace escalate-only definitive-red handling with classify → bounded recover (re-run / archive-aware path / optional assertion fix) → escalate only when budget exhausted; require durable per-head recovery markers; improve block-comment evidence; preserve #181 non-regression (no infinite wait/archive loop) and #281 zero-run path.
- `blocked-recovery-recipes`: Add a dedicated `BlockerKind` (e.g. `ci-exhausted`) and `BLOCKER_RECIPES` entry for pre-merge CI budget exhaustion, distinct from generic `needs-human` and from local `test-gate-exhausted`.

## Impact

- **Code:** `core/scripts/stages/pre_merge.ts` CI-failure branch (~975–1005 today); new classification + recovery helpers; durable per-head markers (worktree and/or run-store, design decision); injectable deps for re-run / log fetch / optional fix.
- **GH wrappers:** `core/scripts/gh.ts` — likely `rerunFailedWorkflow` / run-id resolution and optional log-excerpt fetch; `CheckRun` already exposes `link` for URLs.
- **Types / recipes:** `core/scripts/types.ts` — new `BlockerKind` + `BLOCKER_RECIPES` entry; snapshot tests in `core/test/blocked-recipes.test.ts`.
- **Config (optional):** knobs for assertion auto-fix enablement / cap (default off or 0 unless design enables a safe default of one).
- **Tests:** unit tests with injected check/re-run/log deps (no live network): flake → re-run → green advances; double fail → needs-human once; archive-only + prior green; #181 non-regression; durable marker survives simulated restart.
- **Mirror:** After `core/` changes, regenerate `plugin/` via `node scripts/build.mjs` in the same commit; `npm run ci` must pass.
- **Out of scope:** merge-queue repair (#675), waiving required checks, changing review/delta-auto-fix (#359) except that CI-assertion fix (if enabled) remains a separate path from review-finding auto-fix.

## Acceptance criteria

Observable, falsifiable outcomes that make #679 done:

- [ ] When `getPrChecks` reports definitive failures, the gate classifies the failure set into one of `infra`/`flake`, `assertion`/`product`, or `unknown` (classification recorded in run evidence and/or block comment).
- [ ] On first infra/flake red for a head SHA (after any one-shot rebase policy still applies), the gate triggers a single failed-workflow re-run and returns `waiting` without calling `setBlocked`.
- [ ] If the same head SHA is still red after that one re-run, the gate calls `setBlocked` exactly once with the dedicated CI-exhaustion blocker kind and does **not** re-run again or return perpetual `waiting`.
- [ ] For an archive-only head (`openspec/**` only vs pre-archive SHA) whose pre-archive SHA had successful checks, first red that classifies as infra/unknown prefers re-run / close+reopen-family recovery over immediate hard block; block comments (if later escalated) include pre-archive green SHA evidence.
- [ ] When assertion auto-fix is enabled by config, at most one surgical fix+push+re-wait occurs per head SHA; a durable marker prevents a second automatic fix loop; with the feature disabled, assertion failures escalate after other budget steps without auto-fix.
- [ ] Escalated block comments include: failing check name(s) + conclusion, job/run URL(s) when available, head SHA, classification, short log excerpt when available, and exact next operator steps (including whether re-run was already attempted).
- [ ] #181 non-regression: definitive red never returns infinite `waiting`/re-archive; recovery budgets are finite and durable across process restart for a given head SHA.
- [ ] Unit tests with injected deps prove: simulated flake fail → re-run → green advances without needs-human; simulated double fail → block once; no live network/git/subprocess in those tests.
- [ ] OpenSpec change validates (`openspec validate pre-merge-ci-classify-and-recover`); implementation lands with `npm run ci` green and regenerated `plugin/` if `core/` changes.
