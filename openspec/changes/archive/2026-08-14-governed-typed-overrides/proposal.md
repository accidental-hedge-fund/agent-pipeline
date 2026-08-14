## Why

Agent Pipeline records finding overrides and scoped dispositions, but override reasons stay largely free-form, authority is not consistently resolved, and ordinary finding dispositions lack a first-class expiration and remediation lifecycle. An enterprise assurance path cannot treat “someone left a reason” as change control: overrides need typed scope, authenticated authority, evidence, expiration, renewal, and invalidation.

## What Changes

- Add a **versioned override class / reason taxonomy** and a strict config surface that binds each class to authorized actors/roles (or external group refs), required evidence, maximum duration, separation-of-duty rules, and renewal/remediation requirements.
- Record each override decision with **authenticated actor**, **authorization resolution**, affected findings/components, exact **evidence subject**, reason class plus bounded explanation, evidence/remediation references, `created_at`, `expires_at`, and **supersession / renewal lineage**.
- **Revalidate or invalidate** overrides when candidate, policy, ownership, affected component, or verifier identity changes (via shared `evidence_subject` currency).
- Preserve **append-only history**: an override may be superseded or renewed by a new record; it is never silently rewritten.
- Add a **renewal-lite path** so expiry does not force recurring mandatory human touches when the underlying finding fingerprint and code region are unchanged; require a human only on drift. Route expiry and integrity outcomes through the typed escalation surface (#760).
- Keep **compatibility** for existing low-risk free-form dispositions via an explicit migration path that maps them into the taxonomy without silent elevation of authority.
- **Product boundary:** Pipeline enforces override validity and emits ledger events. Project Warrant may view, alert, and analyze; it MUST NOT bypass Pipeline enforcement or auto-approve renewal/remediation.

**Not changing:** the Warrant overrides dashboard; merge authority; auto-merge absence; non-reproducing machine dispositions as human overrides; plan-review as agent review.

## Acceptance criteria

- [ ] Config accepts a versioned override-class taxonomy and per-class policy (authorized actors/roles or group refs, required evidence links, max duration, SoD, renewal/remediation rules); unknown classes and invalid policy fail at parse time.
- [ ] Unauthorized, expired, malformed, or scope-mismatched overrides cannot unblock a run (fail closed; finding remains blocking).
- [ ] Required evidence and remediation references are enforced by class; missing required refs reject the disposition.
- [ ] Each recorded override carries authenticated actor, authorization resolution, affected findings/components, evidence subject, reason class + bounded explanation, evidence/remediation refs, `created_at`, `expires_at`, and lineage fields for supersession/renewal.
- [ ] Candidate, policy, ownership, affected-component, or verifier identity drift revalidates or invalidates active overrides so they no longer unblock.
- [ ] History is append-only: supersession and renewal create new records linked to prior decisions; prior records keep their original expiry and content.
- [ ] Renewal-lite auto-renews (or keeps current) when finding fingerprint and code region are unchanged; human authority is required on drift; auto-renew does not invent new human authority.
- [ ] Expiry and integrity outcomes use the typed escalation surface (#760); no new unrecoverable park classes.
- [ ] Run evidence distinguishes active, expired, superseded, renewed, rejected, and invalidated overrides.
- [ ] Machine-readable events support age, recurrence, class, authority, renewal, and downstream-outcome analysis.
- [ ] Existing low-risk free-form dispositions have an explicit compatibility/migration path that does not silently grant higher authority.
- [ ] Unit tests cover authorization, expiry, renewal-lite, human renewal, candidate/policy/ownership drift, SoD, repeated overrides, append-only history, and parse-time class/policy failure — via injectable deps only.
- [ ] `npm run ci` is green after implementation; if `core/` is edited, `plugin/` is regenerated in the same change.

## Capabilities

### New Capabilities

- `governed-overrides`: Versioned override class taxonomy, per-class policy, authenticated authority resolution, evidence and remediation enforcement, expiry, renewal-lite and human renewal, supersession lineage, invalidation on subject drift, append-only ledger, and fail-closed unblock gates.

### Modified Capabilities

- `review-severity-policy`: Finding and scoped override application SHALL require a currently valid governed override (class, authority, evidence, subject currency, expiry) before excluding a finding from the blocking set; free-form-only dispositions follow the compatibility path.
- `override-auto-resume`: Auto-resume after override SHALL re-enter advance only when the recorded disposition is currently valid under governed-override rules; invalid/expired dispositions SHALL NOT clear blockers solely by resume.
- `pipeline-configuration`: Accept and strictly validate the optional `override_governance` (or equivalent) config block; unknown keys and unknown classes fail parse.
- `evidence-bundle`: Record override lifecycle state (active / expired / superseded / renewed / rejected / invalidated), authority resolution, class, lineage, and subject binding for run evidence.
- `evidence-subject`: Bind each readiness-relevant override record to the shared immutable evidence subject; currency rules invalidate overrides on governed dimension drift.
- `escalation-site-dispositions`: Inventory override-expiry, unauthorized-override, SoD-violation, and malformed-override sites with closed dispositions (integrity fail-closed; renewal-lite and wait paths resume-safe where applicable); no new unrecoverable park classes.

## Impact

- **Config:** new strict schema block for override classes and per-class policy; defaults preserve today’s low-risk disposition path under an explicit compatibility class.
- **Engine:** `review-policy.ts` override parse/record/extract/partition; `pipeline.ts` / `pipeline override` command; trusted actor resolution; pure validity evaluation; event emission.
- **Evidence:** `OverrideRecord` and evidence-bundle fields; subject binding at record time; machine-readable lifecycle events.
- **Operator surfaces:** CLI override argument / class syntax, status/blocker prose for expired/invalidated overrides, docs for class taxonomy and migration.
- **Tests:** unit tests under `core/test/` with injectable deps; mirror regen when `core/` changes.
- **Related (compose, do not re-own):** #575 pre-code attestation authority/expiry/SoD patterns (landed), #692 evidence subject (landed), #576 / outcome-linkage for downstream override outcome analysis (landed), #599 intent/evidence lineage (related, not a code-stack dep), #760 escalation dispositions (landed).
- **Product boundary:** Pipeline enforces validity and emits facts; Warrant consumes them for views/alerts/renewal workflows without bypass.
