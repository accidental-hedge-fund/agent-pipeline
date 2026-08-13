## Why

Deterministic checks and agent review cannot own architectural judgment. High-risk changes (auth, storage/migrations, public API, architecture, large blast-radius work) need an explicit human authority boundary **before implementation starts**, not after expensive code already exists. Plan-review is independent agent review plus an optional human feedback window; it is not human sign-off. Design-gate (#436) interrogates decisions **after** implementing. Issue #575 closes the pre-code human-judgment gap with a configurable, risk-triggered attestation gate that fails safely and preserves evidence.

## What Changes

- Add an opt-in **`pre_code_attestation`** configuration block in `.github/pipeline.yml` covering enablement, armed built-in risk classes, repository-specific trigger extensions, pre-code size/blast-radius thresholds, attestation expiration/re-approval, authorized-approver resolution, and optional separation of duties.
- Evaluate risk triggers **deterministically before implementation** from issue metadata plus the proposed plan/dossier surface (not only post-code path diffs).
- For triggered work, require a compact **pre-code design dossier** (part of the existing plan/evidence artifact — not four new product stages) with vertical-slice behavioral contracts, add/change/remove behavior diffs, stated-vs-derived classification, and repo-native verification references or explicit `Untestable:` reasons.
- Gate advancement into `implementing` on **affirmative attestation** from an authenticated actor authorized under the effective policy for every affected component and risk class; record actor, identity source, authorization resolution, timestamp, scope, decision, dossier revision/hash, and effective policy revision/hash.
- Bind attestation and dossier identity to the shared **`evidence_subject`** contract (#692) so material dossier, scope, risk classification, ownership, identity, or policy changes invalidate prior approval.
- Route wait/unavailable/expired non-response paths through the **typed escalation surface** (#760 dispositions): default-resume-safe holds; integrity failures (rejection, unauthorized, SoD, config error, post-approval scope mismatch) fail closed. Do **not** mint new unrecoverable park classes.
- Preserve **backward-compatible autonomy**: omitted config → current behavior; configured but untriggered low-risk work → bounded autonomous path without dossier/attestation.
- Trace each approved behavioral contract through implementation and final verification/shipcheck evidence; missing traceability fails safely; `Untestable:` exceptions remain visibly unverified and never report as test-proven.

**Not changing:** design-gate agent interrogation, plan-review as agent review (not human sign-off), merge authority boundary, auto-merge absence, mandatory multi-stage Product/Architecture/Program Design/Vertical Slice orchestration, CODEOWNERS/GitHub-teams-as-required-provider, Specter/EARS/universal requirements syntax.

## Acceptance criteria

- [ ] `.github/pipeline.yml` accepts a typed `pre_code_attestation` block (documented with examples) controlling enablement, armed built-in risk classes, repo-specific trigger extensions, pre-code size/blast-radius thresholds, expiration/re-approval, authorized-approver resolution, and optional separation of duties.
- [ ] Unknown or invalid keys/values under `pre_code_attestation` are rejected at config-parse time (strict schema); they are never silently ignored.
- [ ] When the block is omitted, an end-to-end run matches current autonomous behavior for planning → implementation advancement (no dossier requirement, no human attestation hold).
- [ ] When the block is present and enabled but no risk trigger matches, the run takes the bounded autonomous path without dossier or attestation, and evidence records why the gate remained inert.
- [ ] Risk triggers evaluate deterministically before `implementing` from issue metadata plus the proposed plan/dossier surface and record matched classes with concrete evidence (or a documented not-matched reason).
- [ ] A triggered run produces a compact pre-code design dossier before implementation: intended outcome (and rough UI mockup when UI work), system boundary and key interaction sequence, expected call-stack/file-tree delta, key types/contracts/interfaces, independently testable vertical slices.
- [ ] Each slice is an explicit behavior diff whose contracts are typed `addition` | `change` | `removal` against accepted repository behavior.
- [ ] Each slice carries structured behavioral contracts covering happy path and relevant failure/retry/concurrency cases (preconditions, command/input, expected state/output/event, ownership boundary, failure/retry/concurrency notes, stated vs derived, verification reference).
- [ ] Behaviors inferred rather than explicitly requested are marked `derived` and require explicit accept or reject during attestation; rejected derived behaviors cannot remain in the approved dossier.
- [ ] Each contract identifies a repo-native test, eval, schema, scenario, or other verification reference, or an explicit `Untestable:` reason; an authorized human must affirm each `Untestable:` exception; downstream evidence preserves it as unverified and never labels it test-proven.
- [ ] Triggered work cannot enter `implementing` without affirmative attestation from an authenticated actor authorized under the effective policy for every affected component and risk class.
- [ ] When separation of duties is enabled, an actor prohibited by policy cannot self-attest or satisfy conflicting roles (e.g. implementer or dossier author as sole approver when SoD forbids it).
- [ ] The attestation record includes actor, authenticated identity source, authorization rule and resolution evidence, timestamp, scope, decision, exact dossier revision or content hash reviewed, and effective attestation-policy configuration revision/hash.
- [ ] A material dossier, implementation-scope, affected-component/risk classification, ownership mapping, identity authorization, or effective policy change after approval invalidates the attestation and returns the item to the gate.
- [ ] Run evidence records effective configuration, trigger evaluation, approver-resolution result, and why the gate fired or remained inert; approved contracts are traceable through implementation to final verification or shipcheck result, with missing traceability failing safely.
- [ ] Rejection, unauthorized approval, unresolved ownership, SoD violation, and configuration-error paths fail safely and preserve evidence; attestor-unavailable and expiration waits use the typed escalation/hold surface without inventing new unrecoverable park classes (default-resume-safe; optional config hard-block).
- [ ] Unit tests cover config parse/defaults, triggering, behavior add/change/remove diffs, stated-vs-derived accept/reject, `Untestable:` handling, dossier/contract completeness, authorized-approver resolution, component/risk ownership, identity mismatch, SoD, contract-to-evidence traceability, invalidation, bypass resistance, approval, rejection, and recovery — via injectable deps only.
- [ ] `npm run ci` is green after implementation; if `core/` is edited, `plugin/` is regenerated in the same change.

## Capabilities

### New Capabilities

- `pre-code-attestation`: Configurable pre-implementation human attestation gate — policy schema, deterministic risk triggers, authorized-approver resolution, separation of duties, attestation records, invalidation, wait/escalation dispositions, bypass resistance, and advancement control into `implementing`.
- `pre-code-design-dossier`: Compact pre-code design dossier and vertical-slice behavioral contracts (behavior diffs, stated/derived, verification refs / `Untestable:`, objective IDs/content hashes for downstream traceability) as part of the existing plan/evidence artifact.

### Modified Capabilities

- `pipeline-configuration`: Accept and strictly validate the optional `pre_code_attestation` block with documented defaults; omit → gate disabled.
- `pipeline-state-machine`: Structural but inert-by-default gate position between plan-review (or planning when plan-review is off) and `implementing`; untriggered/disabled paths pass through without human hold.
- `evidence-bundle`: Record attestation-gate evaluation, dossier revision identity, attestation decision records, contract-to-evidence trace rows, and inert/skip reasons.
- `evidence-subject`: Bind dossier revision and attestation-policy effective hash into subject/policy dimensions used for invalidation (no competing subject vocabulary).
- `escalation-site-dispositions`: Inventory pre-code attestation escalation sites with closed dispositions (integrity fail-closed vs resume-safe wait); no new unrecoverable park classes.
- `plan-review-authority-boundary`: Keep plan-review as agent review / optional feedback window; document that pre-code human attestation is a distinct, opt-in high-risk control — not a redefinition of plan-review as sign-off.
- `eval-multi-change-maintainability`: When #575 controls are configured and risk policy fires, the design-dossier / human-attestation treatment variant is available; absence of config still does not block bare-vs-pipeline runs.

## Impact

- **Config:** `core/scripts/config.ts` / types — new `pre_code_attestation` schema, defaults, generated config reference.
- **Engine:** pure trigger evaluation; dossier validation; approver resolution; attestation verification; invalidation; stage/dispatch wiring before `implementing`.
- **Evidence:** evidence-bundle fields; evidence_subject policy/dossier binding; run-store resume for waiting attestation.
- **Operator surfaces:** docs (config examples), status/blocker prose using existing escalation vocabulary, host skill notes distinguishing attestation from plan-review.
- **Tests:** co-located unit tests under `core/test/`; mirror regen when `core/` changes.
- **Related work (compose, do not re-own):** #692 evidence subject (landed), #693 governed overrides (reuse authority/expiry/SoD patterns when available), #695 policy lifecycle/drift, #760 escalation dispositions (landed living spec), #436 design-gate (post-code agent interrogation remains separate).
- **Product boundary:** Agent Pipeline enforces the gate and emits evidence. Project Warrant may view dossiers/attestations; it MUST NOT invent approval or bypass Pipeline enforcement.
)
