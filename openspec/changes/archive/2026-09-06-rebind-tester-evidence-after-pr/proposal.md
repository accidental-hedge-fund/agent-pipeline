## Why

v1.40.1 native FRG on candidate `835c667728aaa311fcda9c9c31d6cb8f7b3aa7a1` dead-ended both synthetic paths (#1464 / PR #1466, #1465 / PR #1467). Implementing runs the test gate before a PR exists, so trusted-surface is not yet candidate-observable and Tester evidence is written without a readiness `evidence_subject`. After the PR is created, the same SHA resolves trusted-surface `passthrough`/`rebound`, but the next delivery stage (design-gate) refuses before execution with `required implementation evidence role, observed missing`. Durable recovery then spends scratch/checkpoint/publish recipes and re-enters the same refuse. That blocks a clean native FRG pack and therefore release.

## What Changes

- **Class law, not an FRG mole.** After an implementation commit is pushed and the linked PR makes candidate/trusted-surface identity observable, Pipeline SHALL deterministically bind or reproduce current-SHA Tester evidence with the required implementation role **before** the first consumer delivery-stage evidence observer runs. Ordinary advance, nested advance, `single`, `loop`, and FRG SHALL share that path.
- The rebound/reproduction SHALL pin the final pushed PR head SHA. It SHALL NOT bless pre-push, stale-SHA, or blocked trusted-surface evidence.
- If PR head or trusted-surface identity cannot be observed after push, the path SHALL fail closed with a typed actionable blocker.
- Recovery SHALL classify this as a deterministic evidence-ordering case. It SHALL NOT spend `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, or `publish_unpublished_stage_commit` on that diagnostic.
- Delivery-stage binding, trusted-surface, review, merge, and FRG requirements SHALL NOT be weakened.

**BREAKING:** none. `on_missing` stays `fail_closed`. Advance/loop still never merge.

## Acceptance criteria

- [ ] Fixture: implementation test gate passes before PR creation while trusted-surface readiness subject cannot yet be emitted; after PR creation the same SHA resolves passthrough/rebound; the next delivery stage receives valid implementation evidence instead of refusing `observed missing`.
- [ ] The rebound/reproduction is exact-SHA and uses the final pushed PR head. It never blesses pre-push, stale-SHA, or blocked trusted-surface evidence.
- [ ] If PR head or trusted-surface identity cannot be observed after push, fail closed with a typed actionable blocker.
- [ ] Recovery does not spend unrelated scratch/publish recipes for this deterministic evidence-ordering case.
- [ ] No weakening of delivery-stage binding, trusted-surface, review, merge, or FRG requirements.
- [ ] Unit tests inject I/O; no real network, git, or subprocess. Regression fails without the fix.
- [ ] `node scripts/build.mjs` and `npm run ci` pass.

## Capabilities

### New Capabilities

<!-- None. Reuse Tester producer, trusted-surface decision, delivery-stage observer, and durable recovery catalogue. -->

### Modified Capabilities

- `tester-evidence`: After PR-backed trusted-surface becomes `passthrough` or `rebound` for the same candidate SHA, bind or reproduce SHA-matched Tester evidence with the required implementation role and a readiness `evidence_subject` before the first consumer delivery-stage observer. Fail closed with a typed blocker when PR head or trusted-surface identity cannot be observed after push.
- `evidence-subject`: When Tester previously omitted `evidence_subject` because trusted-surface was not yet candidate-observable, and a later same-SHA decision is `passthrough` or `rebound`, the rebound/reproduced record SHALL emit a well-formed subject. Blocked trusted-surface SHALL still omit a fabricated subject.
- `issue-stage-adapters`: Consumer delivery stages (design-gate and later) SHALL observe that rebound implementation-role evidence instead of refusing `required implementation evidence role, observed missing`. Binding, Candidate-epoch, and role-exact rules SHALL stay in force.
- `durable-blocker-classification`: The delivery-stage missing-implementation-role refuse after PR-backed trusted-surface resolution SHALL be a deterministic evidence-ordering case. Recovery SHALL NOT spend `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, or `publish_unpublished_stage_commit` for it.

## Impact

- **Class vs site.** The site is FRG #1464 / #1465 at design-gate. The class is: Tester produced before PR-backed trusted-surface is observable, then a consumer delivery stage requires implementation-role evidence with a readiness subject. An FRG-only skip, a design-gate-only guard, or a synthetic-pack mole is incomplete.
- **Reuse first.** Extend the existing Tester producer (`runTestGate` / `writeTesterEvidence`), `ensureTrustedSurfaceDecision`, delivery-stage evidence observer / `completingEvidenceBindingFailure`, and the durable recovery recipe catalogue. Do not add a second evidence family, a second recoverer, or an FRG-only controller.
- **Affected surfaces:** `core/scripts/testgate.ts`, `tester-evidence.ts`, `pipeline-run.ts` (post-PR trusted-surface + Tester rebind before the next consumer stage), `issue-stage-adapters.ts` / `createDeliveryStageEvidenceObserver`, `loop/recovery.ts` recipe selection, injected-seam tests. Hosts stay argv wrappers; regenerate `plugin/` after `core/` edits.
- **Does not:** bypass FRG; edit attestation evidence by hand; merge synthetic FRG PRs; treat labels or host prompts as merge/release authority; weaken delivery-stage binding, trusted-surface, review, or merge; add `auto_merge` or a merge stage.
- **Live evidence:** loop `loop-64b652f9cb0c95a4`; #1464 run `1464-2026-09-05T20-16-07-770Z` candidate `d440d97b66474120c9d7f599f980bf6e0bd27eb0`; #1465 run `1465-2026-09-05T20-39-57-243Z` candidate `4adedcd0ce3867b17c6c091f9ee00aff66577661`. Both: test gate passed; design-gate refused required implementation evidence role as missing.
