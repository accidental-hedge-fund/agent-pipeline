## Context

See `proposal.md` for motivation and the #1459 / v1.40.1 dogfood path.

**Already landed:**

- `resolveReviewedShaCurrency` in `core/scripts/stages/pre-merge-sha-gate.ts` (`current` | `superseded` | `unknown`).
- `reconcileReviewCurrency` in `core/scripts/reconcile-and-converge.ts` (reuse / re-review / hold / fail-closed).
- `enforceReviewShaGate` runs **during** pre-merge. It does not run when resume starts at visual-gate or later.
- `tryResumeStaleBlocked` runs on enter only when `pipeline:blocked` is present and the stage is resume-eligible (pre-merge / fix / review). An unblocked visual-gate resume never hits it.
- `isPipelineInternalCommit` in the neutral pipeline-commits module is the #98 reuse classifier.
- Nested whole-item advance, `pipeline single`, and loop item dispatch all call `runAdvance`.
- Recovery Episodes already key on candidate epoch. Cursor reset already requires a new epoch or material evidence. That law is not applied to later-stage review-currency resume today.

**Class vs site (engine dogfood):**

- **Class:** a later-stage resume (any stage after review has already passed) can run without reconciling PR HEAD against current review evidence. Stale review then authorizes visual-gate, eval-gate, shipcheck-gate, or ready-to-deploy.
- **Site:** #1459 visual-gate resume after developer assertion commit `4c052bb1`.
- **Shared law:** reuse the existing review-SHA currency reconcile at `runAdvance` dispatch for every later stage. Reuse Recovery Episode epoch keying so recovery cannot noop a review-stage item from pending checks or a prior-epoch failure episode.
- **Next identical fault:** eval-gate, shipcheck-gate, or ready-to-deploy resume after a developer HEAD move is already covered. A new mole issue is not required for the same class.

## Goals / Non-Goals

**Goals:**

- One dispatch-time later-stage guard that all advance entry points share.
- Reuse the existing currency helper and internal-commit classifier. Do not invent a second SHA-gate product.
- Atomic return to `review-1` on superseded HEAD before any later stage handler runs.
- Recovery next-action after epoch change cannot treat review-stage work as noop from pending checks or a stale prior episode.

**Non-Goals:**

- Changing pre-merge in-flight SHA-gate delta review (diff-hash / delta vs full) while the issue is still at `pre-merge`.
- A visual-gate-only SHA check.
- A new candidate-epoch store or new review-currency schema.
- Auto-merge, merge authority, or ready-to-deploy merge.
- Weakening same-head residual blocking keys or #98 approval reuse for pipeline-internal-only tips.
- Inventing `--override` because HEAD moved.

## Decisions

### D1: Guard lives on `runAdvance` dispatch, not inside visual-gate

**Choice:** Before `runAdvance` dispatches `visual-gate`, `eval-gate`, `shipcheck-gate`, or `ready-to-deploy`, reconcile review currency against the linked PR HEAD. On superseded or unclassifiable-with-moved-head, transition to `review-1` and `continue` the same advance loop (same pattern as stale-block resume). Do not call the later-stage handler.

**Why this is the first holding rung:** nested, single, and loop already enter `runAdvance`. The currency helper and `transition()` already exist. A visual-gate-only check would miss eval/shipcheck/ready-to-deploy and would be a site mole.

**Alternatives rejected:**

- **Patch `advanceVisual` only.** Site mole. Eval, shipcheck, and ready-to-deploy stay fail-open.
- **Route back to pre-merge (shipcheck's existing post-verdict pattern).** The issue requires return to `review-1` and exact-SHA review of the new HEAD. Pre-merge SHA gate can reuse or delta-review; later-stage evidence is already stale and must not run first.
- **New SHA-gate module.** Duplicates `resolveReviewedShaCurrency`.

### D2: Later stages are visual-gate through ready-to-deploy; pre-merge keeps its SHA gate

**Choice:** The new guard covers `visual-gate`, `eval-gate`, `shipcheck-gate`, and `ready-to-deploy`. Pre-merge continues to use `enforceReviewShaGate` (exact match, internal-only reuse, diff-hash, delta vs full).

**Why:** The fail-open is resume **past** pre-merge. Forcing review-1 on every pre-merge SHA mismatch would regress the documented delta-review path. Pre-merge is still a post-review stage in the label machine, but it already holds the SHA gate. This change closes the gap after that gate has been left.

**Shipcheck interaction:** If review SHA is superseded, this guard runs first and returns to `review-1`. If review SHA is current and only a later shipcheck verdict SHA is stale, existing shipcheck revalidation to pre-merge remains.

### D3: Currency outcomes map to later-stage actions

**Choice:**

| Currency | Later-stage action |
|---|---|
| `current` (exact SHA or pipeline-internal-only) | Dispatch the later stage as today |
| `superseded` (non-pipeline-internal in S..H) | Invalidate prior-SHA review/test/readiness authority. Atomic `transition` to `review-1`. Do not run the later stage. Continue the same advance so review-1 can run. |
| `unknown` and H is readable and H ≠ S | Same as superseded (conservative re-review at H). Cannot prove internal-only reuse. |
| PR missing / HEAD unreadable | Fail closed: do not dispatch the later stage; do not reach ready-to-deploy; do not invent a pass. |

**Why:** Matches SHA-gate / stale-block supersession plus fail-closed observation. Returning to `review-1` is the issue's required epoch restart, not delta-at-visual-gate.

**Exact-SHA review:** The new review-1 invocation MUST evaluate HEAD H and record `reviewed-sha` H. It MUST NOT reuse the S verdict as approval for H.

### D4: Invalidation is routing plus evidence authority, not a new store

**Choice:** Do not add a durable "epoch invalidated" table. Authority invalidation is: (1) later stage does not run, (2) stage label becomes `review-1`, (3) ready-to-deploy and later-gate evidence bound to S cannot authorize H. Existing candidate-integrity / review-SHA rules already refuse stale review for readiness; this change makes later-stage dispatch obey them.

**Why:** First holding rung. A new epoch ledger would be a custom layer the implementer then has to build.

### D5: Recovery cannot noop review-stage after epoch change

**Choice:** After a new candidate epoch, RecoverySupervisor / next-action MUST treat `review-1` / `review-2` as actionable. Pending checks on H, or a Recovery Episode (cursor, exhaustion, prior failure) keyed to S, MUST NOT classify that item as `noop`. Start or resume an episode keyed to the new epoch. Existing Recovery Episode law already says a new epoch starts a new episode; this change makes later-stage review-currency resume a consumer of that law.

**Why:** The issue names this fail-open explicitly. Pending CI is not a reason to skip exact-SHA review. A prior-epoch failure episode is not authority that review is done.

**Alternatives rejected:**

- **Wait for green checks before review-1.** Review-1 does not require green CI. Parking on pending checks would hide the epoch change.
- **Keep the old episode cursor.** Violates existing epoch-key law and would skip review after HEAD movement.

### D6: Tests prove the class, not only visual-gate

**Choice:** One hermetic `runAdvance` fixture that starts at `visual-gate` with review SHA S and developer HEAD H MUST fail without the guard (reaches ready-to-deploy or invokes visual-gate). Controls cover eval-gate, shipcheck-gate, ready-to-deploy, internal-only reuse, unreadable HEAD, nested/single/loop sharing `runAdvance`, and recovery noop classification. Inject deps only.

## Risks / Trade-offs

- **[Risk] Returning to review-1 re-runs full review instead of pre-merge delta.** → Accepted. Later-stage evidence is stale. The issue requires exact-SHA review-1. Pre-merge in-flight delta path is unchanged.
- **[Risk] Unknown currency with H ≠ S re-reviews more often after rebase.** → Same conservative bias as stale-block D2. Unreadable HEAD still fails closed.
- **[Risk] Double work: archive commit then developer commit.** → Internal-only archive stays current. Only the developer commit starts the epoch. Matches #1459.
- **[Risk] Ready-to-deploy finalize currently lives outside the common dispatch block.** → The guard MUST run before that terminal finalize, not only before visual/eval/shipcheck handlers.
- **[Risk] Shipcheck route-to-pre-merge and this guard could fight.** → Order is fixed: review-currency guard first. Shipcheck SHA revalidation only runs when review currency is current.

## Migration Plan

- No config, label schema, or grant-file migration.
- After implement: `node scripts/build.mjs`; `openspec validate invalidate-later-stage-resume`; `npm run ci`.
- Rollback: revert the dispatch-time guard. Pre-merge SHA gate and stale-block resume stay.

## Open Questions

None. Pre-merge stays on the existing SHA gate. Later-stage superseded HEAD returns to `review-1`. Those choices are locked by the issue text and the first holding rung.
