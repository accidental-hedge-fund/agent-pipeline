## Why

Dogfood **#597** pre-merge entered a **long poll thrash** after marker dirt was cleared: durable events showed repeated `gate_result` with `ci=partial` / reason **`rebased; CI re-running`** every ~30–40s while GitHub checks were already **settled failure** (`test` FAILURE — docs drift). The advance process never settled on a classifiable red; operators burned CI minutes and had to kill the advance PID. The product fix was a one-line README commit — the factory should have blocked once with readable CI evidence.

#679 already added classify + bounded recovery for definitive red, but the poll path can still claim `rebased; CI re-running` (and re-emit partial `gate_result`s) when the tip stays red and recovery side-effects do not actually move HEAD or re-request workflows. That is a thrash / truthfulness hole, not a missing recovery matrix.

## What Changes

- **Settled-failure settle rule:** When required checks are **settled failure** (conclusions such as `failure` / `cancelled` / equivalent — not `pending` / `queued` / `in_progress`), pre-merge SHALL NOT treat the same red tip as “rebase and wait again” in a tight loop.
- **Truthful `rebased; CI re-running`:** That waiting reason is valid only when the rebase **actually moved HEAD** or workflows were **explicitly re-requested** and checks are still pending — not when the same red tip is re-polled with no new work.
- **One attempt per recovery class per head SHA:** Finite ordered ladder (rebase → classify → re-run → archive close+reopen → optional assertion fix → escalate). Not a single global action; not multi-fire of the same class on the same SHA. If still red after applicable budgets → **block** with `ci-exhausted` / offramp `ci-failed` and failing check names (capped log excerpt when available).
- **Explicit durable recovery-state model:** Run-scoped `pre-merge-ci-recovery.json` keys attempt state by recovery class + head SHA; persist-before-side-effect with write+read-back; fail-closed to `ci-exhausted` if markers cannot be read/written. Worktree-only rebase markers are not sufficient.
- **Authoritative HEAD movement:** Rebase waiting reason requires pre/post `getPrDetail.head_sha` change, not bare push exit 0. External head advances re-evaluate the new SHA rather than attributing the move to a failed/no-op rebase.
- **Terminal observability:** On escalate, durable events show terminal `ci=fail` **once per failed head SHA**; pure re-polls must not spam `ci=partial` / `rebased; CI re-running`.
- **Tests:** Unit regressions for settled failure → block with no repeated rebase side-effect; pending → still waiting; second hop after one allowlisted recovery at head H → block.

## Capabilities

### New Capabilities

- _(none)_ — behavior tightens the existing pre-merge CI gate; no new capability name.

### Modified Capabilities

- `pre-merge-ci-gate`: Add settled-failure no-thrash requirements — truthful waiting reasons after recovery side-effects, durable one-shot recovery that cannot re-fire for an unchanged red head, and terminal `ci=fail` / block when budget is exhausted for that head SHA. Preserve #181 / #679 non-regression (no infinite wait/archive spin; finite durable budgets).

## Impact

- **Code:** `core/scripts/stages/pre_merge.ts` — `handleDefinitiveCiFailure` rebase step, recovery ladder returns, durable CI recovery markers (`pre-merge-ci-recovery.json` / polling context), and `gate_result` emission for CI fail vs partial.
- **Possibly:** `tryRebaseAndPush` return shape (or a wrapper) so callers can distinguish “HEAD moved” / “no-op up-to-date” / “failed” instead of a bare boolean.
- **Tests:** `core/test/pre-merge-ci-recovery.test.ts` (and/or a focused thrash regression file) with injected deps — no live network/git/subprocess.
- **Mirror:** After `core/` changes, `node scripts/build.mjs` and commit regenerated `plugin/` in the same change; `npm run ci` must pass.
- **Out of scope:** Fixing product README content for #597; expanding the full CI recovery matrix (#281 family) beyond stopping thrash; auto-merge; changing `ci_mode: local` beyond existing block semantics.

## Acceptance criteria

Observable, falsifiable outcomes that make #771 done:

- [ ] Unit test: required checks settled `failure` at head `H` with recovery budget exhausted (or inapplicable) → outcome `blocked` with CI offramp / `ci-exhausted` (or equivalent CI class); fake records **no** repeated rebase side-effect across multiple poll hops on the same `H`.
- [ ] Unit test: checks still `pending` → outcome remains `waiting` / partial (no false settle to fail).
- [ ] Unit test: after **one** allowlisted CI recovery attempt at head `H`, a second poll with the same head still red **blocks** rather than rebasing or re-requesting recovery again.
- [ ] Unit test: a no-op “rebase” that does **not** move HEAD does **not** return reason `rebased; CI re-running` as if CI were freshly re-triggered; the budget for that recovery class is still consumed so the next hop cannot thrash.
- [ ] Durable run events for an escalated red head include a terminal CI `gate_result` with `result: "fail"` (or the established blocked equivalent) rather than unbounded `result: "partial"` rows with reason `rebased; CI re-running` for the same failed SHA.
- [ ] Dogfood-class behavior: red docs (or assertion) CI on a pre-merge PR parks once with readable failing check names / excerpt; process does not require operator kill of the advance PID to stop the loop.
- [ ] OpenSpec validates (`openspec validate pre-merge-ci-settled-failure-no-thrash`); implementation lands with `npm run ci` green and regenerated `plugin/` if `core/` changes.
