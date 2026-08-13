## Context

See `proposal.md` for motivation and dogfood evidence (#1013 / sibling #1017 by hand).

**Already landed (epic #1028 / living `engine-class-live-sibling`):**

- Module `core/scripts/stages/engine-class-live-sibling.ts` with provenance marker, ready + engine-class + bug labels, body `Depends on`, pre-create dedup by evidence key, post-create title/key + rate-cap reconcile, and module-level train milestone context.
- Default recover hook: successful `unlink_engine_scratch` best-effort calls `autoFileEngineClassLiveSibling` with `getTrainMilestoneContext()`; failure is non-fatal.
- `pipeline train` sets / clears train milestone context around the train run.
- Unit coverage in `core/test/engine-class-live-sibling.test.ts` for labels, Depends on, dedup, no-milestone, and rate-cap overflow reconcile.

**Still the #1021 contract (this change):**

- Prove and close gaps so the **full issue acceptance** is locked: recover-only trigger (no human-decision / product dirt path files a sibling), victim continues after recover even when sibling file fails or is skipped, train does not STOP solely for a cleared mechanical block or sibling filing, milestone assignment fail-closed, #538 backlog-only policy untouched for other auto-file categories.
- Prefer first-class train/loop run context for milestone (#1023 landed composition); keep explicit milestone argument / train CLI context as the supported seam if run-context is not threaded further.
- Ensure unit tests cover recover→sibling coupling and non-trigger negative cases, not only the pure filer module.

Hard dependency: **#1020** (engine-scratch recover). Soft preference: **#1023** for stable train milestone context (already available via train CLI).

## Goals / Non-Goals

**Goals:**

- One open live sibling per first recovered engine-class `evidence_key` in-window, on the current train milestone when known.
- Victim item stays on the recover→resume path to ready-to-deploy; engine fix lands on the sibling, not the victim PR.
- Cross-host safety parity with other auto-file categories (GitHub state authoritative; host-local lock is same-host fast path only).
- Fail closed: no milestone guess; no file on human authority or product dirt; no auto-merge / override.

**Non-Goals:**

- Reversing #538 for papercuts, corrections, or durable-run-blockers.
- LLM decides whether something is an engine bug.
- Patching engine source into the blocked (victim) PR.
- Softening true `human-decision-required` or design / credential holds.
- Continuous multi-repo ship model (#1024).
- Auto-merge or merge-stage configuration.
- Expanding sibling filing to product-class review findings or unverified prose clusters.

## Decisions

### D1: Trigger only after successful engine-class / engine-scratch recover

**Decision:** Live sibling filing is invoked only from the successful first-class engine-class recover path (today: `unlink_engine_scratch` after #1020 classification and clear). Product dirt, `human-decision-required`, design / credential holds, and ordinary review findings never call the filer.

**Rationale:** Issue is a narrow #538 exception for engine moles recovered in-run. Broad triggers would auto-advance unrelated work onto the train milestone.

**Alternatives:** File from any `workflow-engine-defect` diagnostic (rejected: may fire before recover succeeds or on non-scratch residuals that should park). File from papercut engine-class signals (rejected: those stay backlog-only per #538 / #755).

### D2: Reuse cross-host auto-file pattern; independent marker-scoped rate-cap

**Decision:** Keep a dedicated provenance marker (`<!-- pipeline-auto-file: engine-class-live-sibling -->`) and category-local rate-cap membership over open issues with that marker. Pre-create: skip if open sibling already holds the same `evidence_key` (or equivalent title identity) or category window cap is full. Post-create: reconcile title/key duplicates and category-wide overflow down to lowest-numbered open survivors. Numeric window/max may reuse existing auto-file default knobs; membership must not consume papercut / correction / durable-run-blocker budgets.

**Rationale:** Matches #631 / cross-host auto-file dispositions; epic first cut already followed this shape.

**Alternatives:** Share papercut marker and budget (rejected: mixes backlog papercuts with live train siblings). Host-local lock only without post-create reconcile (rejected: cross-host overshoot).

### D3: Train milestone from run context; fail closed on assignment

**Decision:** When `pipeline train --milestone <M>` (or ship playbook equivalent) is driving the run, expose `M` to the filer. Prefer first-class train/loop context when present (#1023). If no milestone is in scope, create the sibling without a milestone argument. Never invent a milestone from unrelated open milestones or `suggestMilestoneForBlockerClass` prose.

**Rationale:** Issue acceptance requires current train milestone when known, and explicit fail-closed when not.

**Alternatives:** Always omit milestone (rejected: loses train ordering for dogfood). Infer “latest open milestone” (rejected: wrong release). Assign backlog suggested milestone strings (rejected: advisory only today).

### D4: Labels ready + engine-class + bug; body Depends on recovered item

**Decision:** Labels are exactly the live set: `bug`, `pipeline:engine-class` (stable marker), `pipeline:ready`. Body includes the provenance marker, evidence key, recovered item reference, and a machine-usable `Depends on: #<N>` line. Never add `pipeline:backlog` on this path.

**Rationale:** Loop advances `pipeline:ready`; train honors `Depends on` for ordering after the victim.

**Alternatives:** File as backlog and rely on manual triage (rejected: dogfood failure mode). Put engine fix into victim PR (rejected: issue non-goal).

### D5: Non-fatal relative to recover; never auto-merge or override

**Decision:** Sibling create / list / reconcile failures log and return; they must not reverse recover success, re-apply `pipeline:blocked`, or invoke merge / override. The filer itself never merges PRs.

**Rationale:** Recover is the ship-path critical path; sibling is best-effort autonomy so the engine fix is tracked in-release.

**Alternatives:** Fail recover if sibling create fails (rejected: re-creates train STOP / false park).

### D6: Spec surface is MODIFIED living capability, not a new capability name

**Decision:** Strengthen `engine-class-live-sibling` requirements (recover coupling, non-fatal, independent rate-cap, train-milestone fail-closed) rather than invent a second capability path.

**Rationale:** Living capability already names this surface; #1020 used the same “lock full child contract after epic seed” pattern.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Module-level train milestone context races if two train runs share one process | Supported concurrency is single-host sequential train; clear context when train ends; document; prefer explicit milestone arg on the filer call when available. |
| Sharing numeric papercut window/max knobs confuses operators | Membership is marker-scoped; document independence; optional follow-up for dedicated config keys if ops need different caps. |
| Recover path files siblings for non-scratch workflow-engine defects if classification drifts | Trigger only after successful engine-scratch unlink/recover classification; product dirt fails closed before recover success. |
| Duplicate siblings under race across hosts | Post-create reconcile closes extras to lowest-numbered open survivors (same as other auto-file categories). |
| Reviewer pressure to put engine fix on victim PR | Spec non-goal; sibling is the durable landing; victim continues without engine-source patch from this path. |

## Migration Plan

1. Specs + design land in this change (planning).
2. Implementation verifies/closes gaps against living first cut; regenerates `plugin/` if `core/` changes.
3. No data migration. Existing open siblings with the marker remain valid.
4. Rollback: disable recover→file hook (or no-op filer); victim recover path remains independent.
5. Archive into living `engine-class-live-sibling` on pre-merge when acceptance is green.

## Open Questions

None that block specs or tasks. Dedicated config keys for this category’s window/max (vs reusing numeric defaults) may be added later without changing observable filing semantics if membership stays marker-scoped.
