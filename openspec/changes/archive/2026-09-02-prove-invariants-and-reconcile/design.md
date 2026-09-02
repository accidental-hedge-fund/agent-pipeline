## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- `DeliveryStageInvariant` in `core/scripts/issue-stage-adapters.ts`, `MERGE_OPERATION_INVARIANT` in `core/scripts/stages/merge-supervision.ts`, and `SHIP_PHASE_INVARIANTS` in `core/scripts/stages/ship-supervision.ts`. All three already declare precondition, postcondition, observer, candidate binding, and replay rule.
- `core/scripts/loop/reconcile.ts` — `ReconcileObserveDeps`, `classifyDrift`, `computeNextAction`, benign `ledger-behind` catch-up. Contradictions currently record and route toward a human (`noop` / documented human route).
- `core/scripts/operation-observation.ts` — `SideEffectCertainty` (`known_complete` | `known_absent` | `uncertain`) and RecoverySupervisor observation sink.
- `core/scripts/loop/precondition.ts` `pipelineStageFromLabels` — first `pipeline:*` label wins. `core/scripts/stages/train.ts` `pipelineStageFromLabels` throws `ambiguous pipeline stage labels` when more than one is present. That throw is the #1369 train STOP.
- `core/scripts/operation-reliability.ts` `reconcileCompletedSideEffect` — later proof does not replay.
- RecoverySupervisor (`CONTEXT.md`, #1323) is the sole lifecycle owner. This change does not invent a second owner.

Engine-dogfood bar:

1. **Class, not site.** The class is an ambiguous or contradictory external side effect treated as process success or human STOP.
2. **Shared law.** Invariant registry, observers, `classifyDrift` / next-action, and stage-label derivation change together. A path-local mole at the train throw is incomplete.
3. **Next identical fault.** A new contradiction or uncertain side effect MUST enter through a violated invariant and observer. The #1369 fixture plus the class-guard test mean a new mole issue is not required.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: extend the existing invariant records and `loop/reconcile.ts`. Do not write a second reconcile engine, observer package, or RecoverySupervisor.
- Prove operation invariants with owning-system observers. Reconcile before retry and after recovery.
- Reconstruct durable local state from git, forge, CI, release, and deployment truth.
- Keep two `pipeline:*` stage labels as a reconcilable observation, not a thrown STOP.

**Non-Goals:**

- Treating the local ledger as stronger authority than git or the forge.
- Provider-specific retry policy.
- Repairing invariants inside the observer (observers report facts; RecoverySupervisor owns treatment).
- External repair from reconciliation (no merge, push, label write, PR edit, release, or deploy).
- Weakening the OpenSpec dirty-before-archive fail-closed (#579 / #1017).
- Reimplementing #1328 worktree rematerialize, #1329 inventory, #1333 fault matrix, or #1326 typed-request classifier.
- A public `pipeline reconcile` verb, grant schema, or second durable scheduler.

## Decisions

### D1 — Extend the existing invariant records in place

Keep the three existing invariant types. Add `side_effect_identity`, `safe_replay_predicate`, and `reconstruction_rule` on that same record shape. A shared TypeScript alias is allowed only if it is the existing five-plus-three field object, not a new framework.

Contract tests already fail a delivery stage without an invariant. Extend those tests so a missing new field fails the same way. Merge and ship invariants join that contract.

Alternative considered: a new `operation-invariants.ts` registry that stages import. Rejected as a custom layer. The declarations already live next to the adapters.

### D2 — Observers are typed reads on existing seams

Do not add an observer service. Extend `ReconcileObserveDeps` (and the merge/ship observation types already used) so each fact has one owning-system read:

| Fact | Owning system | Existing seam to extend |
| --- | --- | --- |
| Run ownership | host-local lock / claim | issue-run lock, operation claims |
| Issue stage | GitHub labels | `getIssueStateAndLabels` plus shared stage derivation |
| Worktree and candidate identity | git worktree + remote tip | `getLocalHead`, porcelain, rebase-in-progress |
| Commit publication | git remote | existing push/containment observers |
| PR identity and HEAD | GitHub pull request | `getPrDetail`; observe **all** linked PRs, not only the latest open |
| Checks | GitHub checks | `getPrChecks` |
| Reviews | review verdict artifacts | existing SHA-bound verdicts |
| Merge containment | GitHub merge state + git ancestry | merge-supervision observers |
| Release / deployment | release provider / live digest | ship-supervision lineage observers |
| Authority validity | typed-request records + candidate epoch | existing handoff / grant binding |

Local ledger, claims, and comments are intent history. They cannot overrule those reads.

Alternative considered: a parallel `AuthoritativeObserver` interface per fact. Rejected: `ReconcileObserveDeps` is the holding rung.

### D3 — One stage-label derivation; most advanced `STAGES` member wins

Replace train's throw and loop's first-wins with one pure function. Input is the live label list. Output is exactly one `pipeline_stage` or null.

Rules:

- Collect labels with prefix `pipeline:` whose suffix is a member of `STAGES`.
- If none, return null.
- If several, return the member with the greatest index in `STAGES` (most advanced). `needs-human` is last and therefore wins over any in-flight stage when both are present.
- Compatibility labels that are not `pipeline:*` stages (`blocked`) stay on `isBlockedInLabels`. They do not compete as a stage.
- Reconciliation SHALL NOT write GitHub labels to drop leftovers. A later supervised label-transition mutation may do that under its own invariant.

Train freeze/eligibility and loop identity both call this function. A fixture with `pipeline:pre-merge` and `pipeline:design-gate` yields `pre-merge` and does not throw.

Alternative considered: fail-closed throw until a human removes a label. Rejected by the issue: contradictions stay supervisor-owned.

### D4 — Reconstruct local state; add `reconstruct` to `LoopNextAction`

Supersede "route contradictions to a human". Keep "no external mutation".

- `ledger-behind` stays `repair-forward`.
- `ledger-ahead`, `external-absent`, and `identity-mismatch` without typed-request evidence become `reconstruct`: rewrite durable local ledger, claim, and last-verified identity to match the observer, append history, emit an event, keep the item owned.
- `hold-for-human` still requires a current canonical `human-decision-required` diagnostic after the shared classifier.

`noop` remains for aligned items with nothing to do, not for contradictions.

Alternative considered: reuse `repair-forward` for both directions. Rejected: forward catch-up and local reconstruction are different audits. Extending the existing closed set by one member is the holding rung.

### D5 — Observe all linked PRs before successor mutations

`findPrForIssue` today can return the latest open PR and miss a prior squash-merge of the same issue. Before opening a PR, rebasing, or treating advance as still needed, observe every linked PR (open, closed, merged). If any linked PR is merged and its merge-result is contained in the fetched base, the integration side effect is `known_complete`. Do not open a successor PR on the same branch. Do not rebase squash-contained commits onto that merge.

Issue closed via `Closes #N` is corroborating evidence, not the sole postcondition.

This is the #1369 remote-mutation class.

### D6 — Side-effect certainty before replay; rebase-in-progress is observation

Reuse `SideEffectCertainty`. Before any replay:

- `known_complete` → reconstruct forward, do not replay.
- `known_absent` → may replay under the same side-effect identity and candidate epoch.
- `uncertain` → Cooling, external-condition wait, or CapabilityRequest. Do not guess.

A worktree with `rebase-in-progress` (`.git/rebase-merge` or `.git/rebase-apply`), claimed SHA ≠ on-disk HEAD, or staged product dirt is local/remote drift. Reconciliation records it. RecoverySupervisor may then run a recipe (abort rebase, rematerialize) as a recovery action, not as observer repair. Archive cleanliness fail-closed on product dirt remains.

A first archive that already landed, followed by a later archive seeing rebase dirt, is a partial external operation: observe the completed archive (`known_complete`) and the unfinished rebase (`uncertain` / in-progress) before any second archive attempt.

### D7 — Candidate epoch is candidate identity movement

Reuse CONTEXT.md Candidate epoch. New HEAD, rematerialized SHA, remote-advanced tip, or replacement worktree starts a new epoch. Candidate-bound review, test, eval, shipcheck, decision, and authority evidence from the prior epoch is invalid. #1326 already consumes this for typed requests.

Do not use process lifetime or retry number as the epoch.

### D8 — Violated invariant, not error-name branch

New fault shapes enter as: invariant named, observer fact, certainty, reconstruction or wait. A production `catch` that switches on `ambiguous pipeline stage labels` or another thrown message fails a class-guard test. Generic mechanical, workflow, infrastructure, authentication, and unknown classes stay in the #1333 matrix; this change does not invent incident-title routing.

### D9 — #1369 is a required fixture, not a new product issue

One injected-I/O regression covers, together:

1. Forge squash-merge of this issue's PR while stage is `fix-2` (remote mutation by another actor).
2. Worktree mid-rebase onto that squash; claimed SHA ≠ on-disk HEAD; staged OpenSpec product dirt (local/remote drift).
3. Labels `pipeline:pre-merge` and `pipeline:design-gate` (contradictory labels).
4. First archive pass succeeded; later archive sees unfinished-rebase dirt (partial external operation).

The fixture fails if train throws, if a successor PR is opened, if squash-contained commits are replayed, if dirty-archive fail-closed is skipped, or if the item is `hold-for-human` without typed-request evidence.

## Risks / Trade-offs

- **Existing tests expect contradiction → `noop` or human route.** → Update those tests to expect `reconstruct` and supervisor ownership. Keep `hold-for-human` only with current typed-request evidence.
- **Most-advanced stage could hide a leftover `needs-human`.** → `needs-human` is last in `STAGES` and wins when co-present. Independent typed-request evidence still parks. A leftover earlier stage with `pre-merge` yields `pre-merge`.
- **Reconstructing ledger-ahead could drop a true merge that the observer has not yet seen.** → Uncertain merge visibility stays `uncertain` (D6) and Cooling, not reconstruct-to-open. Reconstruct ledger-ahead only when the observer proves the remote fact is absent or different.
- **Aborting rebase looks like repair.** → Reconcile only observes. Abort/rematerialize is a RecoverySupervisor recipe after that observation (#1328 seam).
- **`findPrForIssue` callers assume one PR.** → Additive: return or consult the linked-PR set for completeness; keep a primary PR for identity display. Tests must fail if only the latest open PR is consulted after a prior merge.

## Migration Plan

1. Extend invariant records and contract tests (red on missing fields).
2. Unify stage-label derivation; point train and loop at it.
3. Add `reconstruct` to `LoopNextAction`; change `classifyDrift` consumers.
4. Observe all linked PRs; refuse successor PR-open and squash-contained rebase when a linked PR is merged and contained.
5. Wire observe-before-retry / after-recovery at existing RecoverySupervisor re-entry points.
6. Add the #1369 fixture and the error-name class guard.
7. Keep dirty-before-archive fail-closed.

Rollback: revert next-action and train derivation first. Additive invariant fields remain backward compatible if optional during one revision; required on newly written invariants.

## Open Questions

None. Issue #1324 already locked invariant fields, observer authority, candidate epochs, observe-before-replay, no external repair, and supersede-human-route.
