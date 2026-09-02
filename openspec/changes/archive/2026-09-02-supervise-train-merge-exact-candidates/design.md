## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- `core/scripts/stages/merge.ts` — `mergePr` gates (mergeability with UNKNOWN budget, required checks, linked `pipeline:ready-to-deploy`, `--match-head-commit`). Throws on gate failure or uncertain `gh pr merge`. No durable claim. No post-mutation GitHub reconcile.
- `core/scripts/stages/merge-queue.ts` / `merge_queue_hold.ts` — sequential `mergePr`, typed holds, opt-in repair. Holds continue remaining candidates. Repair exhaustion is a hold, not a shared recovery episode.
- `core/scripts/stages/train.ts` — production `recoverParked` dep (#1061 one pass per park), `mergeIssuePr` → `mergePr`, `observePr` + base containment. Independent-sibling holds already exist for contained parks. Train still owns a second recoverer.
- `core/scripts/stages/ship-supervision.ts` — operation invariants, claims, `SideEffectCertainty`, Cooling. Pattern to copy, not a module to import into merge.
- `core/scripts/loop/recovery.ts` — Cooling, claimed attempts, strategy cursor.
- `core/scripts/loop/reconcile.ts` — observe live forge/git/CI truth before replay.
- `core/scripts/candidate-integrity.ts` — pre-mutation claim for head-moving repair. Merge squash is not a covered mutation site today.
- `core/scripts/recover-parked.ts` — remains the operator CLI.
- RecoverySupervisor (`CONTEXT.md`, #1323) as sole lifecycle owner. This change does not invent a second owner.
- ADR 0003 (supervised operations retain ownership).

Class vs site: command-local STOP after uncertain merge, train's second `recover-parked` pass, and merge-queue repair exhaustion as ownerless work are one integration-supervision class. Shared merge invariant, claims, observers, and crash fixtures are the class fix. A merge-only mole would miss merge queue and train.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: keep `mergePr` as the merge mutation. Add a merge-supervision observation/claim layer next to it, matching `ship-supervision.ts`. Train and merge-queue compose that adapter. Remove production `recoverParked` from train.
- Reuse loop recovery inside advance waves. Reuse independent-sibling hold and serial merge waves already in train.
- Reconcile GitHub merge state and base containment before any merge replay.
- Bind derived merge authorization to the inspected head. Re-derive after head movement without widening the operator envelope.

**Non-Goals:**

- A second RecoverySupervisor, train-local recovery state machine, grant schema, or scheduler.
- Making `advance` / `single` / `loop` merge.
- Repository-configured merge authority or an `auto_merge` key.
- Changing merge-queue dry-run default.
- Reimplementing ship-phase supervision (#1331), liveness (#1332), operation inventory (#1329), or the fault matrix (#1333).
- Deleting the `recover-parked` CLI.

## Decisions

### D1 — Merge adapter wraps `mergePr`; RecoverySupervisor is the owner

Keep `pipeline merge`, `pipeline merge-queue`, and `pipeline train --merge` as the public surfaces. Do not add `pipeline supervise-merge`. Put merge operation invariant, claim, and side-effect certainty in a `merge-supervision` module beside `merge.ts`, copying the `ship-supervision.ts` pattern. Do not import ship-supervision (wrong bounded context). Do not extract a generic RecoverySupervisor package in this change.

If the RecoverySupervisor module is not yet landed, merge/train/queue SHALL still emit the same typed observations and claims that module will consume. Do not fork a train-local policy table.

Alternative considered: make train, merge, and merge-queue each own recovery. Rejected: that is the current ownerless STOP.

Alternative considered: replace `mergePr` with a generic RecoverySupervisor driver. Rejected: `mergePr` already has the exact-candidate gates. First holding rung is to stop those gates from declaring terminal policy for supervised callers.

### D2 — One merge invariant table, three composers

Declare the shared invariant once. `pipeline merge`, merge-queue apply, and train merge waves consume it. Gate details stay in `mergePr` (UNKNOWN budget, checks, stage, match-head-commit). Composers MUST NOT loosen those gates.

Train already observes merge-result containment after `mergePr`. Lift that observe-and-contain step into the shared postcondition so merge-queue apply and crash recovery use it too.

Alternative considered: keep containment as a train-only proof. Rejected: then merge-queue crash recovery cannot prove the postcondition.

### D3 — Claim before `ghPrMerge`; reconcile after crash

Reuse the loop recovery claim shape (operation + candidate identity + evidence fingerprint + `outcome: "started"`). Charge the claim before the merge mutation. Crash after `started` reconciles PR `state`/`mergedAt`/`mergeCommit.oid` and `git merge-base --is-ancestor` of that OID in the fetched base.

Certainty mapping:

| Observation | Certainty | Next |
| --- | --- | --- |
| PR merged and merge-result contained | known_complete | complete; no replay |
| PR open, head unchanged, merge not submitted | known_absent | may submit after gates |
| Timeout, crash mid-mutation, unreadable merge response | uncertain | observe; no replay until known |

A moved `headRefOid` invalidates the claim. Re-run exact-candidate gates. Do not submit `--match-head-commit` for a stale SHA.

Alternative considered: treat timeout as absent and retry immediately. Rejected: that can double-merge.

### D4 — Train drops `recoverParked`; loop recovery stays

Delete production wiring of `deps.recoverParked` in `pipeline.ts` / `train.ts`. Parks after an advance wave become observations. Deterministic recipes (scratch unlink, unpublished publish, stale-block resume) already run inside the loop/advance-wave controller (`autonomous-recovery-controller`). Residual-review parks that still need `recover-parked` stay owned Cooling or a typed request. Operators and RecoverySupervisor recipes MAY still call the CLI.

Update `docs/supervisor.md` so train no longer "does this automatically."

Alternative considered: keep one recover-parked pass then hand remaining parks to RecoverySupervisor. Rejected: that is still a second recoverer.

### D5 — Operator CLI may exit non-zero; supervised callers stay owned

Standalone `pipeline merge` MAY still exit non-zero for conflict, checks, or UNKNOWN exhaustion. That is operator UX. Train and merge-queue apply MUST persist owned Cooling/wait and MUST NOT treat that exit as ownerless train/queue terminal.

Same disposition as ship vs standalone `pipeline release`.

### D6 — Original envelope authorizes scope; gates derive candidate authorization

The operator argv is the authority envelope. No grant file. Derived merge authorization is the claim after gates pass. Head movement invalidates the derivation, not the envelope. Resume of the same argv re-derives.

Do not add config keys. Do not let recover-parked or host retry mint merge authority.

### D7 — Independent siblings reuse train's contained-hold path

Do not add a scheduler. Map Cooling/wait onto the existing `holdContainedItem` / independent-sibling continuation. Dependents stay excluded by the existing base-eligible frontier (merge-result contained). Merge concurrency stays one.

### D8 — Crash tests inject merge seams in `merge.test.ts` / `train.test.ts` / merge-queue tests

Add fresh-process fixtures that:

1. Run until the merge claim is `started` or the observer shows complete.
2. Drop the process (new `mergePr` / train / merge-queue call on the same store).
3. Assert no second `ghPrMerge` and owned lifecycle if the postcondition is unproven.

Cover at least: crash before submission, crash after submission before persist, crash after persist. Inject gh/git/observer fakes. No real network, git, or subprocess.

## Risks / Trade-offs

- **[Risk] #1323 RecoverySupervisor is still a forthcoming module.** → Mitigation: emit the observation/claim types CONTEXT.md already names. Do not ship a second policy owner. Implementation tasks that call RecoverySupervisor APIs wait on that module in the same milestone graph.
- **[Risk] Removing train `recover-parked` leaves residual-review parks without the one automatic reflow.** → Mitigation: that reflow is a RecoverySupervisor recipe, not a train mole. Loop recovery still runs inside the wave. Operator CLI remains. Tests prove train does not call `recoverParked`.
- **[Risk] Standalone `pipeline merge` exit codes change if we persist Cooling instead of throw.** → Mitigation: D5. Keep operator non-zero exit. Supervised callers consume the observation object, not the process exit, as lifecycle.
- **[Risk] Merge-queue dry-run spec still describes apply as unimplemented.** → Mitigation: this change does not rewrite that stale paragraph except to add apply reconciliation. Do not expand into a full merge-queue spec cleanup.
- **[Trade-off] Duplicate certainty strings with ship-supervision.** → Acceptable. Copying three literals beats coupling merge to ship or extracting a generic supervisor layer.

## Migration Plan

1. Add merge-supervision invariant, claim, and certainty next to `merge.ts`. Keep `mergePr` gates.
2. Charge the claim before `ghPrMerge`. Reconcile PR + containment on restart. Add the three crash fixtures.
3. Point merge-queue apply and train `mergeIssuePr` at the same adapter. Keep dry-run default.
4. Remove production `recoverParked` from train. Flip train tests that expect the one-pass recoverer into regressions that fail if it returns.
5. Map Cooling/wait onto contained independent-sibling holds. Keep dependent exclusion.
6. Align CLI / supervisor docs / `CONTEXT.md` terms. Run `node scripts/build.mjs` after `core/` edits.
7. `openspec validate supervise-train-merge-exact-candidates` and `npm run ci`.

Rollback of this change: revert the merge-supervision and train wiring patches. Prior recover-parked auto-invoke and throw-on-uncertain-merge would return. Do not restore a second scheduler.

## Open Questions

None. Deployment of merge is GitHub squash-merge plus base containment. There is no separate merge provider in scope. Operator envelope vs derived candidate authorization is decided in D6.
