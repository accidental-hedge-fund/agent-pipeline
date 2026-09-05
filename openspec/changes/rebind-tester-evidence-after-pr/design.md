## Context

See `proposal.md` for why. Current law and code:

- Living `tester-evidence` already lets the producer omit `evidence_subject` when trusted-surface is `blocked` (fail-closed subject, suite record still written). Implementing runs `runTestGate` **before** `createPr`. `ensureTrustedSurfaceDecision` cannot yet observe a linked PR head, so the first Tester write is subject-less.
- After implementing opens the PR and transitions to `design-gate`, the same SHA resolves trusted-surface `passthrough`/`rebound`. Consumer delivery stages are not producers (`evidenceProducerBeforeAttempt` is false). `runDeliveryStageAdapter` observes evidence **before** the handler and refuses when `evidenceRole` is not `implementation`: `required implementation evidence role, observed missing`.
- `createDeliveryStageEvidenceObserver` currently infers implementation role from worktree/PR product paths (`observeImplementDeliverablePaths`). It does not consume SHA-matched Tester evidence. A subject-less Tester record is therefore unused as consumer-stage implementation proof.
- Durable recovery classifies the refuse as `workflow-engine-defect` and claims `unlink_engine_scratch` → `checkpoint_owned_harness_dirt` → `publish_unpublished_stage_commit` → restart/repair. Those recipes cannot emit the missing role. The loop re-enters design-gate and refuses again.

Living `evidence-subject` already forbids a fabricated subject on blocked trusted-surface. It does not require a post-PR rebind once the same SHA becomes `passthrough`/`rebound`.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is FRG #1464 / #1465 at design-gate. The class is: Tester produced before PR-backed trusted-surface is candidate-observable, then a consumer delivery stage requires implementation-role evidence with a readiness subject. An FRG-only skip or a design-gate-only guard is a mole.
2. **Shared surfaces.** Rebind lives on the existing Tester producer + trusted-surface decision + delivery-stage observer used by `runAdvance` (ordinary, nested, `single`, `loop`, FRG). Recovery uses the existing durable recipe catalogue with a diagnostic-scoped applicable recipe. No second evidence family, no second recoverer, no FRG controller.
3. **Next identical fault.** The next implement-then-design-gate whose test gate ran before the PR existed uses the same post-PR rebind before the consumer observer. Unit tests fail if design-gate still sees `observed missing` after same-SHA trusted-surface `passthrough`/`rebound`, or if recovery charges scratch/publish for that diagnostic.

## Goals / Non-Goals

**Goals:**

- After push + linked PR, re-resolve trusted-surface for the final PR head. If `passthrough` or `rebound`, bind or reproduce SHA-matched Tester evidence with implementation role and a well-formed `evidence_subject` **before** the first consumer delivery-stage observer.
- Consumer observers accept that rebound Tester record as implementation-role proof. Path-exact proof stays sufficient. Binding stays SHA-exact and role-exact.
- Fail closed with a typed blocker when PR head or trusted-surface identity cannot be observed after push.
- Recovery does not claim or charge scratch/checkpoint/publish for this diagnostic. The applicable recipe is the same rebind.
- Tests inject I/O and bite on the #1464/#1465 ordering.

**Non-Goals:**

- Inventing a readiness subject on blocked trusted-surface.
- Re-running the product suite when a SHA-matched passed Tester record already exists for the final PR head (bind the subject; do not treat a second suite run as required).
- Weakening `completingEvidenceBindingFailure`, trusted-surface blocked law, review `fail_closed`, merge, or FRG pack requirements.
- A new `DurableBlockerClass` or a second RecoverySupervisor.
- Merging synthetic FRG PRs; hand-editing attestation evidence; `auto_merge`.

## Decisions

### 1. Shared post-PR rebind on the existing advance loop (primary)

**Choice:** After an implementation commit is pushed and a linked PR exists, `runAdvance` SHALL re-resolve trusted-surface for the live PR head, then bind or reproduce SHA-matched Tester evidence, **before** the next consumer delivery-stage `observeEvidence("before")`. Nested advance, `single`, `loop`, and FRG share this because they enter `runAdvance`. Do not add an FRG-only hook.

**Why:** The refuse happens at the consumer observer, not inside FRG scoring. A design-gate-only patch leaves nested/single/loop on the same hole.

**Alternatives considered:**

- Rebind only inside the design-gate handler → rejected. Observer refuses **before** the handler. Other consumer stages can hit the same hole.
- Defer to `loadOrRegenerateTesterEvidenceForReview` at review-1 → rejected. The dead end is design-gate, before review.
- Skip the consumer observer when Tester suite status is `passed` → rejected. Weakens delivery-stage binding.

### 2. Bind subject onto SHA-matched suite evidence; reproduce only when needed

**Choice:** Reuse `writeTesterEvidence` / `buildTesterEvidence` and the existing trusted-surface decision.

- If SHA-matched Tester evidence exists for the **final pushed PR head** with a recorded suite pass, and trusted-surface is now `passthrough` or `rebound` with a trustworthy verifier pin, **bind**: rewrite that record with a well-formed `evidence_subject` and implementation role. Do not require a second suite command.
- If no SHA-matched record exists for that head, or the record is stale/malformed relative to that head, **reproduce** via the existing deterministic producer (`runTestGate` / equivalent) at that head, then persist with subject + role.
- Never copy a pre-push SHA, a different candidate SHA, an all-zero trusted-surface sentinel, or a blocked-surface fabricated subject.

**Why:** First holding rung. The suite already passed. The missing fact is the readiness subject + implementation role after TS became observable. Re-running `npm run ci` is not the class fix.

**Alternatives considered:**

- Always re-run the suite after PR open → rejected as latency without new suite authority when the SHA did not move.
- Invent subject without a passthrough/rebound decision → rejected. Violates living `evidence-subject`.

### 3. Consumer observer treats rebound Tester evidence as implementation-role proof

**Choice:** Extend `createDeliveryStageEvidenceObserver` (same function, no second observer). For consumer stages that require `implementation`, SHA-matched Tester evidence that carries a well-formed `evidence_subject` and implementation role for the observed candidate SHA SHALL prove `evidenceRole: "implementation"` and artifact identity. Existing exact product-path proof remains sufficient. Planning-role artifacts still cannot satisfy implementation stages. Process exit, labels, comments, and PR merge state still cannot infer the role.

**Why:** The issue names Tester evidence as the missing implementation-role proof. Path classification alone left `observed missing` after PR-backed TS resolution. Rebind without observer consumption would still refuse.

**Alternatives considered:**

- Inject producer-completion evidence across stage boundaries via a new store → rejected. Second evidence channel.
- Loosen `completingEvidenceBindingFailure` to treat `null` role as optional after a PR exists → rejected. Weakens binding.

### 4. Fail closed when PR head or trusted-surface identity is not observable after push

**Choice:** After push, if the linked PR head is missing, not a full 40-character SHA, or disagrees with the pushed head, or trusted-surface remains unresolvable / `blocked` with no trustworthy verifier pin, persist a typed actionable blocker (closed code on the observation / run evidence). Do not run the consumer observer against missing role. Do not invent a subject. Do not open design-gate as verified.

**Why:** AC3. Fail visible. Same class as other named persist/acquire codes: machine-readable, not generic `observed missing`.

### 5. Recovery: diagnostic-scoped rebind recipe; do not charge scratch/publish

**Choice:** Keep class `workflow-engine-defect` (no new `DurableBlockerClass`). Add one catalogue recipe, e.g. `rebind_tester_evidence_after_pr`, that executes the same shared rebind. For a structured evidence-ordering diagnostic (consumer delivery-stage missing implementation role after PR-backed TS `passthrough`/`rebound`, or after subject-less Tester at the same SHA), that recipe is the applicable one. `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, and `publish_unpublished_stage_commit` SHALL be inapplicable for that diagnostic: recorded as skip, **not claimed, not charged**. Classification SHALL use the structured diagnostic / evidence fields, not harness name or free-form prose.

**Why:** Class-over-site. The next crash between PR open and rebind must hit the same rebind, not spend scratch/publish and loop. Living law already says inapplicable recipes skip without consuming a later bound; this diagnostic must actually mark those recipes inapplicable.

**Alternatives considered:**

- New blocker class → rejected. Closed taxonomy + policy compilation cascade for one ordering hole.
- Leave recovery unchanged because primary path is enough → incomplete class: a crash after PR open still burns scratch/publish.
- Put rebind first on every `workflow-engine-defect` → rejected. Unrelated engine defects would claim a no-op rebind and charge it.

### 6. Implementation order is primary rebind, then observer, then recovery

**Choice:** Ship in one PR. Prove in this order: (1) post-PR bind/reproduce before consumer observer; (2) observer accepts rebound Tester as implementation role; (3) recovery does not charge scratch/publish and claims the rebind recipe for that diagnostic. A green (1)+(2) fixture should normally eliminate the refuse. (3) covers the crash/re-entry class.

## Risks / Trade-offs

- **[Risk] Binding a subject onto suite evidence looks like a readiness pass under a blocked surface.** → Mitigation: bind only when the same-SHA trusted-surface outcome is `passthrough` or `rebound` with a trustworthy verifier pin. Blocked stays fail-closed. Tests assert no fabricated subject.
- **[Risk] Observer accepting Tester evidence weakens path-exact implementation proof.** → Mitigation: Tester proof is SHA-matched, subject-well-formed, and role `implementation`. Planning-role and subject-less records remain insufficient. `completingEvidenceBindingFailure` stays.
- **[Risk] Reproduce path re-runs a long suite on every design-gate.** → Mitigation: bind when SHA-matched passed evidence already exists for the final PR head. Reproduce only on missing/stale/malformed for that head.
- **[Risk] Recovery still charges scratch because executors return recovered/no-op instead of inapplicable.** → Mitigation: diagnostic-scoped applicability **before** claim. Tests fail if those three recipes are started/charged for this fingerprint.

## Migration Plan

- Ship in one PR with `core/` + regenerated `plugin/`. No config key. No Tester schema bump (`schema_version` 1 + nested `evidence_subject`).
- In-flight runs that already refused at design-gate rebind on the next `runAdvance` or on the new recovery recipe, then proceed.
- Rollback is revert. No data backfill.

## Open Questions

None. Post-PR bind-or-reproduce on the shared advance path is primary. Observer consumption of that Tester record is required. Recovery recipe is diagnostic-scoped.
