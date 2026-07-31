## Context

Pre-merge CI gate (`core/scripts/stages/pre_merge.ts`) already:

1. Polls `getPrChecks` and aggregates pending vs failed vs pass.
2. On definitive failure, runs `handleDefinitiveCiFailure` — one-shot rebase → classify → optional re-run / archive close+reopen / assertion fix → escalate with `ci-exhausted` + offramp `ci-failed` (#679).
3. Persists durable per-head markers for re-run / archive-fail / assertion-fix in `runDir/pre-merge-ci-recovery.json`.
4. Emits `gate_result` events (`ci` / `partial|pass|fail`) for loop progress (#682).

Dogfood **#597** showed repeated `ci=partial` / `rebased; CI re-running` while checks were already settled red. Likely contributors:

- **Rebase budget is only worktree-local** (`REBASE_MARKER_FILE` under the managed worktree). Other recovery steps use **runDir-durable** markers. If the worktree is recreated, remounted, or the marker is lost, the ladder re-enters step 1 every poll.
- **`tryRebaseAndPush` returns a bare `boolean`** — success means “rebase + push exit 0”, not “HEAD SHA changed”. A no-op up-to-date rebase + successful force-with-lease push still yields `rebased; CI re-running` even when CI is still the same red tip and no new workflow was requested.
- **Every recovery `waiting` return resets the partial-gate spam guard** (`ciWaitingGateRecorded = false` then re-records). If every poll claims a “new” recovery, operators see unbounded partial rows.

Existing #679 requirements already say budget exhaustion must block and #181 forbids infinite wait/archive spin. This change hardens the **rebase step and waiting-reason truthfulness** so settled red cannot thrash under realistic marker loss / no-op rebase.

## Goals / Non-Goals

**Goals:**

- Settled failure at head `H` after applicable one-shot recovery is consumed → single **block** with readable CI evidence; poll loop exits waiting.
- `rebased; CI re-running` only when HEAD actually moved (or an explicit re-request path is used and checks are pending).
- Rebase attempt consumption is **durable per head SHA** (same class of durability as re-run/assertion markers), not solely a worktree file that can vanish.
- Unit-testable with injected deps; no live network/git in the regression suite.
- Preserve #679 ladder ordering and #181 non-regression.

**Non-Goals:**

- Expanding allowlisted auto-fix classes (docs-check / format product fixes) beyond existing assertion-fix config (#679 / #281 family expansion).
- Fixing product README content for #597.
- Changing `ci_mode: local` semantics.
- Auto-merge or waiving required checks.
- Changing poll interval / timeout defaults solely for thrash (fix correctness, not sleep longer).

## Decisions

### D1 — Treat “settled failure” as definitive failed aggregate (existing parse), not a new GH API

**Choice:** Continue using `parseChecksAggregate` + failed buckets (`fail` / `cancel`). “Settled” means **not pending** and **has failed**. Do not invent a parallel status model.

**Why:** Matches #679 “definitive failures”; keeps one classification entry point.

**Alternatives:** Per-check conclusion enum from GitHub check-runs API — more accurate for mixed states but larger surface; out of thrash scope.

### D2 — Durable per-head rebase-attempted marker in CI recovery JSON

**Choice:** Record rebase attempt against head SHA `H` in the same durable marker file as #679 (`pre-merge-ci-recovery.json` / polling context fields), in addition to (or instead of relying solely on) the worktree `REBASE_MARKER_FILE`. Consume the one-shot rebase budget when a rebase is **attempted** for `H`, whether or not HEAD moved.

**Why:** Dogfood thrash is consistent with re-entering step 1 every poll. RunDir markers already survive process restart for re-run/assertion; rebase must join that durability class.

**Alternatives:**

- Only fix worktree marker placement — fails if worktree is recreated without the file.
- Mark only on successful HEAD move — would re-attempt no-op rebases forever (worse thrash).

### D3 — Waiting reason after rebase requires observable progress

**Choice:** Return `{ status: "waiting", reason: "rebased; CI re-running" }` only when the recovery side-effect **changed the PR head SHA** (pre- vs post-rebase head differ) **or** an explicit workflow re-request path succeeded and checks are still pending. If rebase exits 0 but HEAD is unchanged, **consume** the rebase budget for that SHA and **continue the ladder** (classify → remaining steps → escalate) on the same tick or next poll without claiming CI re-running.

**Why:** Issue acceptance: `rebased; CI re-running` is invalid for the same red tip re-polled. Operators and scoreboard must not see fake progress.

**Implementation sketch (intent, not code):**

- Capture `headShaBefore` from `getPrDetail` / worktree HEAD before rebase.
- After successful push, re-read head (injectable seam) or have `tryRebaseAndPush` return `{ ok, headMoved, newHeadSha? }`.
- Prefer a small return-object evolution over parsing git stdout in callers.

**Alternatives:** Always wait after any push exit 0 — status quo thrash for no-op rebase.

### D4 — Terminal `gate_result` fail on escalate; no unbounded partial for same failed SHA

**Choice:** Keep existing `recordPreMergeGateResult(..., "ci", "fail", ...)` on blocked recovery. Ensure recovery paths that **do not** produce new work do not clear the “already recorded waiting partial” guard in a way that re-spams partial rows every poll for the same red SHA. Prefer: one partial per genuine recovery-induced wait stretch; on budget exhaustion, one fail.

**Why:** Matches acceptance criteria on durable events and #682 spam suppression spirit for pure re-polls of an unchanged red tip.

### D5 — Scope of “allowlisted recovery” for this issue

**Choice:** Map “at most one automated recovery action for allowlisted classes per head SHA” to the **existing** #679 one-shot steps (rebase, re-run, archive close+reopen, assertion auto-fix when enabled). Do **not** invent a new docs-check recovery class in this change. “Second hop blocks rather than rebasing again” is the thrash regression.

**Why:** Issue out-of-scope says no full recovery matrix expansion. Docs red is assertion-class and already escalates when assertion auto-fix is off/exhausted.

### D6 — Polling loop exit remains outcome-driven

**Choice:** No change to `advancePolling` structure beyond outcomes it already honors: `waiting` continues; `blocked` / non-waiting stops. Correctness comes from `advance` returning `blocked` instead of perpetual `waiting` with fake rebase reasons.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| No-op rebase + continue ladder on same tick increases classification/re-run work | Acceptable; one extra classify/re-run attempt is cheaper than infinite poll thrash. |
| HEAD re-read after push races with GitHub eventual consistency | Prefer worktree HEAD / push output when available; if re-read fails, treat as “unknown move” fail-closed: consume budget and continue ladder rather than claim re-running. |
| Changing `tryRebaseAndPush` return type breaks callers | Use a small result type; update BEHIND path and tests in the same change; keep boolean adapter only if needed transiently. |
| Over-eager block when checks are mixed pending+fail | Preserve existing aggregate rules: any pending ⇒ still waiting (no false settle). Unit test covers pending. |
| Durable marker without runDir (single-shot advance) | Same as #679: without durable store, refuse unbounded recovery; escalate rather than thrash. |

## Migration Plan

1. Land OpenSpec change; implement in `core/` with unit regressions that fail without the fix.
2. Regenerate `plugin/` via `node scripts/build.mjs`; `npm run ci` green.
3. No config migration; no label changes.
4. Rollback: revert the PR — prior thrash may return but no schema migration.

## Open Questions

- Whether BEHIND-path rebase (mergeability step, not CI failure ladder) needs the same HEAD-moved truthfulness in this change. **Default:** apply the same result shape and durable one-shot marker so BEHIND cannot thrash with the same reason string; keep conflict recovery semantics otherwise unchanged.
- Exact field name for durable rebase marker (`ciRebaseAttemptedForSha` parallel to `ciRerunAttemptedForSha`) — implementer choice as long as it is per-head and durable.
