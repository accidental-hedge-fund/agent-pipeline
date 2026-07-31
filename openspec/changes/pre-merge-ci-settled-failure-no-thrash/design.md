## Context

Pre-merge CI gate (`core/scripts/stages/pre_merge.ts`) already:

1. Polls `getPrChecks` and aggregates pending vs failed vs pass via `parseChecksAggregate` (`core/scripts/gh.ts`).
2. On definitive failure, runs `handleDefinitiveCiFailure` — ordered one-shot ladder: rebase → classify → optional re-run / archive close+reopen / assertion fix → escalate with `ci-exhausted` + offramp `ci-failed` (#679).
3. Persists durable per-head markers for re-run / archive-fail / assertion-fix in `runDir/pre-merge-ci-recovery.json` (hydrate before side-effect, persist-before-side-effect, fail-closed on write failure).
4. Emits `gate_result` events (`ci` / `partial|pass|fail`) for loop progress (#682).

Dogfood **#597** showed repeated `ci=partial` / `rebased; CI re-running` while checks were already settled red. Root causes:

- **Rebase budget is only worktree-local** (`REBASE_MARKER_FILE`). Other recovery steps use **runDir-durable** markers. Worktree recreation re-opens unlimited rebase attempts.
- **`tryRebaseAndPush` returns a bare `boolean`** — success means “rebase + push exit 0”, not “authoritative PR head SHA changed”. No-op rebase still yields `rebased; CI re-running`.
- **Every recovery `waiting` return clears `ciWaitingGateRecorded` and re-emits partial**, so fake recovery progress spams the event stream.

`gh pr checks --json` fields (verified): `name,state,bucket,description,link` (+ `workflow`, timestamps). Buckets: `pass` | `fail` | `pending` | `skipping` | `cancel`. There is **no per-check head SHA** on this surface — settlement is relative to the PR head observed at poll time via `getPrDetail.head_sha`. Stale runs belonging to older commits are out of band for this thrash fix unless GitHub still reports them as current PR checks; aggregate rules already treat any `pending` as non-settled.

## Goals / Non-Goals

**Goals:**

- Settled failure at head `H` after applicable per-class one-shot budgets → single **block** with readable CI evidence; poll loop exits waiting.
- Explicit durable recovery-state model (repo/PR/run-scoped store, keyed by head SHA + recovery class) with atomic attempt recording and fail-closed persistence.
- `rebased; CI re-running` only when authoritative PR head SHA **moved** as a result of our rebase attempt (or an explicit re-request path uses its own non-rebase reason).
- One attempt **per recovery class per head SHA**, finite ordered ladder — not “one action total” and not unbounded re-entry of any class.
- Terminal `gate_result` `ci`/`fail` idempotent per failed head SHA on pure re-polls.
- Unit-testable with injected deps; no live network/git in the regression suite.
- Preserve #679 ladder ordering and #181 non-regression.

**Non-Goals:**

- Expanding allowlisted auto-fix classes (docs-check / format product fixes) beyond existing assertion-fix config (#679 / #281 family expansion).
- Fixing product README content for #597.
- Changing `ci_mode: local` semantics.
- Auto-merge or waiving required checks.
- Changing poll interval / timeout defaults solely for thrash.
- Replacing `gh pr checks` with the Checks API solely to filter by `head_sha` (document limitation; settlement is PR-head-relative via detail + aggregate).

## Decisions

### D1 — Settled-failure aggregate is current-head + pending-first

**Choice:** Keep `parseChecksAggregate`: any non-pass/skipping bucket that is not `fail`/`cancel` ⇒ `pending = true`. **Pending takes precedence over failure** — mixed red+pending is still `waiting`, never recovery or `ci-exhausted`. “Settled failure” means `pending === false && failed.length > 0` for the checks returned for the PR at this poll, evaluated against the **current** `prDetail.head_sha` only. Do not invent a parallel status model.

**Why:** Matches #679 “definitive failures”; `gh pr checks` buckets already collapse state; pending-first prevents thrash recovery while CI is still running.

**Stale older-SHA runs:** `getPrChecks` does not expose check `head_sha`. This change treats returned checks as current-PR status (GitHub’s PR checks view). Do not trigger recovery/block from a synthetic reconstruction of older commits. If a future issue needs SHA-filtered checks, that is a separate `gh` shape change.

### D2 — Explicit durable recovery-state model

**Choice:** Formalize and extend the existing run-scoped store:

| Dimension | Value |
|-----------|--------|
| Store path | `{runDir}/pre-merge-ci-recovery.json` (same file as #679) |
| Scope | One run directory ⇒ one issue/PR in one repo (repo + PR identity is the run) |
| Key | Per recovery class field holding the head SHA for which that class was **attempted** |
| Classes | `rebase` \| `rerun` \| `archive_fail` \| `assertion_fix` (plus existing `preArchiveSha` evidence) |
| Attempt record | Setting `ciRebaseAttemptedForSha` (new) / existing `ciRerunAttemptedForSha` / … to head `H` **before** the side-effect |
| Result record | Optional result fields only where needed for observability (e.g. `ciTerminalFailRecordedForSha` for terminal gate idempotency); budget consumption is attempt-based, not success-based |
| Atomicity | Write full marker object + read-back (existing `saveCiRecoveryMarkers`); treat write/read-back failure as `ok: false` |
| Fail-closed | If `runDir` missing or persist `ok: false`, **do not** return unbounded `waiting` on in-memory-only budget; escalate `ci-exhausted` with `durablePersistFailure` in the block reason (same pattern as re-run step today) |

**Why:** Reviewer correctly rejected vague “durable enough.” Rebase must join the same durability class as re-run/assertion. Attempt-before-side-effect prevents restart double-spend.

**Not chosen:** A new keyed map `attempts[class][sha]` nested structure — more flexible but larger migration/test surface. Parallel scalar SHA fields match existing #679 pattern and are sufficient for one-shot-per-class-per-current-head.

### D3 — Authoritative HEAD before/after rebase (not exit code)

**Choice:** Rebase recovery outcome is a small result object, not a bare boolean:

```ts
type RebasePushResult =
  | { ok: true; headMoved: true; beforeSha: string; afterSha: string }
  | { ok: true; headMoved: false; beforeSha: string; afterSha: string }
  | { ok: false; reason: string; beforeSha?: string; afterSha?: string };
```

Procedure for CI ladder (and BEHIND path, same truthfulness):

1. Capture `beforeSha` from authoritative `getPrDetail(pr).head_sha` (injectable seam already on `AdvancePreMergeDeps`).
2. Run rebase+push (existing git sequence).
3. Re-fetch `afterSha` via `getPrDetail` (or injectable `getHeadShaAfterRebase` if tests need a thinner seam).
4. `headMoved = beforeSha !== afterSha`.
5. Consume one-shot rebase budget for **`beforeSha`** (durable) whether moved, no-op, or failed attempt after the attempt was authorized.
6. Return `rebased; CI re-running` **only if** `ok && headMoved`.
7. If `ok && !headMoved`: continue ladder / escalate — never claim re-running.
8. If `afterSha` differs from `beforeSha` but attribution is ambiguous (e.g. external push concurrent with failed local rebase): treat as **new head evaluation** — do not claim our rebase moved it; durable marker for `beforeSha` still set if we attempted; next poll evaluates `afterSha` with fresh budgets for that SHA.

**Why:** Successful command exit is not evidence of a moved head; dogfood thrash is exactly no-op-success + wait claim.

### D4 — Recovery ladder semantics (precise)

Ordered classes, **one attempt per class per head SHA**:

| Order | Class | When eligible | Budget key | On success side-effect | On no-op / fail side-effect |
|------:|-------|---------------|------------|------------------------|-----------------------------|
| 1 | `rebase` | settled red; not yet attempted for `H` | `ciRebaseAttemptedForSha` | if HEAD moved → `waiting` reason `rebased; CI re-running`; else continue | consume budget; continue ladder |
| 2 | classify | always after rebase step (or skip if already rebased) | n/a (pure) | drives 3–5 | — |
| 3 | `rerun` | class `infra`/`unknown`; `pre_merge_ci_rerun_enabled`; not yet for `H` | `ciRerunAttemptedForSha` | if `result.attempted` → `waiting` reason `CI re-triggered (…)`; **never** `rebased; CI re-running` | consume budget; continue |
| 4 | `archive_fail` | infra/unknown; archive-only+prior green; re-run exhausted/disabled; not yet for `H` | `ciArchiveFailRecoveryAttemptedForSha` | if reopened → `waiting` archive reason | consume; continue / escalate with evidence |
| 5 | `assertion_fix` | class `assertion`; config opt-in; not yet for `H` | `ciAssertionFixAttemptedForSha` | if fix ok → `waiting` assertion reason | consume; escalate |
| 6 | escalate | any remaining settled red | n/a | `setBlocked` `ci-exhausted` + offramp `ci-failed` | — |

Clarification vs issue wording “one automated recovery action”: **one attempt per recovery class per head SHA**, finite ordered ladder — not a single global action, and not multi-fire of the same class on the same SHA.

Rerun/archive/assertion may return `waiting` only after a real side-effect that can change CI state (re-request, close+reopen, fix push). They must not return `waiting` solely because the same red tip was re-polled with budget already consumed.

### D5 — Terminal observability is idempotent per failed head

**Choice:**

- On first escalate for head `H`, record `gate_result` `ci`/`fail` (existing path) and set durable `ciTerminalFailRecordedForSha = H` (new field in same JSON).
- On pure re-poll of the same blocked/settled-red head with budget exhausted: return `blocked` again if still in gate path, but **do not** append another `ci`/`fail` or any `partial` + `rebased; CI re-running` when no new recovery side-effect ran.
- Only clear/allow a new terminal fail when head advances to a new SHA (or a new waiting stretch after genuine recovery that moved work).
- Fix the bug where every `recoveryOut.status === "waiting"` unconditionally clears `ciWaitingGateRecorded` before re-recording — only reset the partial spam guard when a **new** recovery-induced wait stretch starts (side-effect actually occurred). For escalate, keep writing fail once per SHA via the terminal marker.

### D6 — Bounded failure evidence

**Choice:** On escalate, block reason **must** include failing check names (existing `buildCiExhaustedBlockReason`). Include a **capped** log excerpt only when `fetchCheckLogExcerpt` succeeds (existing `trimLogExcerpt`). If log fetch fails/returns null, still escalate cleanly with names + classification + budget flags — never wait for logs, never thrash.

### D7 — Scope of allowlisted recovery

**Choice:** Do not invent a new docs-check recovery class. Docs red is assertion-class under existing classify; when assertion auto-fix is off/exhausted, escalate. “Second hop blocks rather than rebasing again” is the thrash regression.

### D8 — Polling loop exit remains outcome-driven

**Choice:** No change to `advancePolling` structure: `waiting` continues; `blocked` stops. Correctness is `advance` returning `blocked` instead of perpetual fake `waiting`.

## Approach (repo pattern)

Follow the **#679 durable CI recovery marker pattern** already established in `core/scripts/stages/pre_merge.ts`:

- `CiRecoveryMarkers` + `loadCiRecoveryMarkers` / `saveCiRecoveryMarkers` (write + read-back fail-closed)
- `hydrateCiRecoveryMarkers` into `PreMergePollingContext` at the start of `handleDefinitiveCiFailure`
- **Persist marker for head `H` before side-effect**; on persist failure, refuse the side-effect and escalate with `durablePersistFailure`
- Injected seams on `AdvancePreMergeDeps` (`tryRebaseAndPush`, `getPrDetail`, `getPrChecks`, `setBlocked`, …) — tests in `core/test/pre-merge-ci-recovery.test.ts` use fakes only

This change extends that pattern to **rebase** (today worktree-only) and **terminal-fail idempotency**, and changes the rebase result shape so waiting reasons require authoritative HEAD movement.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| No-op rebase + continue ladder on same tick increases classify/re-run work | Acceptable; one extra step cheaper than infinite poll thrash. |
| HEAD re-read after push races with GitHub eventual consistency | Prefer immediate `getPrDetail`; if re-read fails, fail-closed: consume rebase budget, continue ladder, do **not** claim re-running. |
| Changing `tryRebaseAndPush` return type breaks callers | Small result type; update CI ladder, BEHIND path, conflict recovery, and tests in the same change. |
| Over-eager block when checks mixed pending+fail | Preserve pending-first aggregate; unit test red+pending → waiting, no recovery. |
| Durable marker without runDir (single-shot advance) | Same as #679: escalate rather than thrash. |
| Externally advanced head during rebase | Do not attribute move to failed rebase; next poll evaluates new SHA with its own budgets. |
| Duplicate `setBlocked` on re-poll of already-blocked issue | Accept re-entrancy of block label (idempotent enough); focus idempotency on durable **events** (`gate_result` fail once per SHA). |

## Migration Plan

1. Land OpenSpec deltas; implement in `core/` with unit regressions that fail without the fix.
2. Regenerate `plugin/` via `node scripts/build.mjs`; `npm run ci` green.
3. No config migration; no label changes. Marker JSON gains optional fields (`ciRebaseAttemptedForSha`, `ciTerminalFailRecordedForSha`); old files hydrate as empty ⇒ first poll after upgrade behaves as budget unused (safe).
4. Rollback: revert the PR — prior thrash may return; no hard schema migration.

## Open Questions

- None blocking implementation. BEHIND-path rebase uses the same HEAD-moved result shape and durable one-shot class so it cannot thrash the same reason string without progress; conflict-recovery reason string (`rebase-resolved; CI re-running`) stays distinct but still requires HEAD movement for a “CI re-running” claim if it uses the shared helper.
