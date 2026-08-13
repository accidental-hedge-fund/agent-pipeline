## Why

Agent Pipeline correctly parks ambiguous or exhausted work at `pipeline:needs-human`, but that label is too coarse for asynchronous software-factory operation. Operators must reconstruct the exact question, eligibility, candidate context, and resume target from comments, and can answer a stale question or resume the wrong stage. The factory needs a durable, versioned **human-question handoff** record that preserves those facts and makes answer → resume safe without inventing a second workflow state machine.

## What Changes

- Add a versioned, durable **human-question handoff** schema and store that complements existing labels, comments, intervention events, and run evidence.
- Create a handoff only when there is a **bounded question**, a required responder capability or authority, and **current candidate evidence**. Generic engine failure or recovery exhaustion is **not** a product-judgment authority question; it is a typed non-authority manual-repair handoff when a human is still needed.
- Reuse #575's authenticated identity and authorized-approver resolution for **authority-bearing** handoffs. Context/expertise answers that do not grant approval remain explicitly distinct from attestation, approval, and finding override.
- Consume the post-#787 authority predicate: only a valid `human-decision-required` diagnostic with current finding key, fingerprint, and reviewed SHA establishes human **authority**. Labels, prose, stale comments, and generic `needs-human` outcomes do not.
- Provide operator surfaces (human-readable and JSON) to list, inspect, answer, reject, or supersede handoffs; resume only when the answer remains valid for the current candidate and effective policy.
- Surface pending handoff counts and age in queue/budget summaries without treating waiting-human as agent/compute capacity failure; other ready items continue while one attempt waits.
- Keep GitHub labels authoritative for workflow stage; handoffs explain and safely resume that state. Existing `pipeline:needs-human`, blocker recipes, intervention taxonomy, finding overrides, and #575 attestation paths remain compatible.
- Answer/reject/supersede operations are idempotent and append-only audited. Stale, expired, superseded, unauthorized, or scope-invalidated answers never advance the item.

**Not changing:** hosted UI, generic project-management inbox, automatic human assignment when policy cannot resolve one, agent inference of product/release authority from a context answer, replacement of #575 attestation semantics or finding-override evidence, merge authority, or auto-merge.

## Acceptance criteria

- [ ] A versioned handoff schema captures question identity, escalation class, scope/revision hashes, required responder capability or authority, lifecycle status, answer provenance, and resume target.
- [ ] Creating a handoff preserves the active stage and existing `blocked` / `needs-human` behavior; no parallel workflow state machine or new stage label is introduced for handoff lifecycle.
- [ ] A handoff is created only with a non-empty bounded question, required responder capability or authority class, and current candidate evidence (SHA and referenced artifact revisions/hashes where applicable).
- [ ] Authority-bearing handoffs require a current valid `human-decision-required` diagnostic (finding key, fingerprint, reviewed SHA) per post-#787; generic engine exhaustion without a decision question is typed as non-authority `manual-repair` (or equivalent), never as product judgment.
- [ ] Pending handoffs are listable in human-readable and JSON forms filtered by issue, run, repository, and queue batch.
- [ ] An authenticated eligible responder can answer through an audited command/API surface; unauthorized or unidentified actors cannot satisfy authority-bearing handoffs.
- [ ] Non-authority context answers are recorded as a distinct decision class and do not satisfy approval, attestation, or finding-override requirements.
- [ ] Resume revalidates candidate SHA, referenced artifact revisions/hashes, ownership/authority policy, expiration, supersession, and stage preconditions before any advance.
- [ ] A stale, expired, superseded, or scope-invalidated answer never advances the item; evidence of the refusal is preserved.
- [ ] Answer, reject, and supersede operations are idempotent on duplicate delivery and retain an append-only audit trail.
- [ ] Queue/budget summaries expose waiting-human counts and age without classifying them as agent/compute capacity failures; other ready items may continue while one item waits.
- [ ] Existing `pipeline:needs-human`, blocker recipes, intervention taxonomy, finding overrides, and #575 attestation paths remain compatible (no silent semantic replacement).
- [ ] Unit tests cover each handoff class, eligible and unauthorized responders, stale SHA, changed dossier/policy, expiration, supersession, duplicate delivery, rejection, ambiguous resume, successful resume, and concurrent independent work — via injectable deps only.
- [ ] `openspec validate durable-resumable-human-question-handoffs` passes; after implementation, `npm run ci` is green and `plugin/` is regenerated when `core/` changes.

## Capabilities

### New Capabilities

- `human-question-handoff`: Versioned durable handoff record — schema, create eligibility, handoff classes, lifecycle (pending/answered/rejected/superseded/expired), eligible-responder and authority resolution, answer/reject/supersede idempotency, append-only audit, resume revalidation, and fail-closed malformed/unauthorized/stale paths.

### Modified Capabilities

- `needs-human-status-surface`: Status and inspect surfaces list and show pending/answered handoffs with question, class, eligibility, age, and resume target without replacing ceiling-comment punch-list behavior.
- `fix-human-decision-outcome`: When a fix round parks with an accepted needs-human-decision declaration, the engine also creates (or reuses) a durable handoff bound to the declaration evidence; park semantics and non-advance rules remain.
- `batch-queue-engine`: Batch summary and budget reporting expose waiting-human handoff counts and age; waiting items are not dispatched as if they were agent-capacity failures; independent ready items continue.
- `loop-needs-human-blocker-disposition`: Human-hold disposition remains diagnostic-gated; durable handoffs supply the question/resume contract for holds that already qualify, without inventing authority from labels alone.
- `evidence-bundle`: Record handoff create/answer/reject/supersede/resume outcomes and identity hashes in run evidence.
- `command-registry`: Register non-mutating list/inspect and audited answer/reject/supersede (and resume-after-answer if separate) command entries with explicit flag allowlists.
- `escalation-site-dispositions`: Inventory new production handoff create, unauthorized-answer, resume-refusal, and malformed-record sites with closed dispositions (integrity fail-closed; wait/pending not auto-retry of authority).
- `human-intervention-events`: Handoff create/answer/reject/supersede MAY link to or accompany `human_intervention` events without replacing the taxonomy or inventing authority from kind alone.
- `pre-code-attestation`: Document composition only — authority-bearing handoffs reuse #575 authenticated identity and authorized-approver resolution; context handoffs do not satisfy pre-code attestation. No change to attestation approval semantics beyond optional handoff-shaped wait presentation where a wait already exists.

## Impact

- **Core modules:** new handoff types/schema validation, pure resume/eligibility helpers, store/ledger under run-store or issue-scoped durable path, CLI subcommands (or flag-mode entries), status/queue summary projections.
- **Stage integration:** fix human-decision park, other existing `needs-human` / human-input wait emitters that already post a bounded question — create handoff at park time without new stage labels.
- **Authority:** compose with #575 approver resolution and post-#787 `human-decision-required` evidence; do not fork a second policy language.
- **Evidence / events:** evidence-bundle fields; optional `human_intervention` correlation ids; append-only handoff audit log.
- **Operator surfaces:** `pipeline handoff list|show|answer|reject|supersede` (exact names may match registry style); human-readable + `--json`; issue comments may remain the interaction mechanism for v1.
- **Tests:** co-located unit tests under `core/test/`; no real network/git/subprocess in unit tests.
- **Related work (compose, do not re-own):** #575 pre-code attestation authority, #302 intervention taxonomy, #305 queue/budget, #760 reason taxonomy / escalation dispositions, #787 human-decision-required authority predicate, durable-pause-and-authority human-input request shape, override-auto-resume finding overrides.
- **Milestone:** v1.38.0 product-level human/agent resumability (issue triage admits `pipeline:ready`).
