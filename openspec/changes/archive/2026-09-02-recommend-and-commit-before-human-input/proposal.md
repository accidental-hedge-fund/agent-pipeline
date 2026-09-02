## Why

`specification-decision` and missing authority currently collapse into the same terminal human-ownership path. Pipeline asks a human for choices it can safely recommend and commit, and some mechanical context gaps still project as human authority.

## What Changes

- Lift the existing grill `settleRecommendation` classifier into shared typed-request resolution used by grill, advance, recovery, and ship. Do not invent a second classifier, a fourth request type, a new handoff verb, or a new RecoverySupervisor.
- Keep the public request union as exactly `DecisionRequest`, `CapabilityRequest`, and `AuthorityRequest`. Required information is a `CapabilityRequest` reason, not a fourth type. Durable-pause kinds `decision`, `answer`, and `authority-grant` remain compatibility aliases of that union.
- Before any human ask, gather repository, issue, forge, runtime, and policy evidence. Commit a recommendation when it is reversible, in current scope, policy-consistent, already authorized, and not contradicted by authoritative evidence.
- Record every decision resolution with recommendation, rationale, alternatives, risk, and evidence.
- Type a `CapabilityRequest` with the missing capability or information, provider, live probe, and resume condition. A condition that can become true without supplied input is an external-condition wait, not a human ask.
- Type an `AuthorityRequest` with eligible actor, repository, operation, scope, candidate epoch, evidence, and expiry. It never defaults. Product decisions are not authority.
- Invalidate candidate-bound requests and grants when the candidate epoch moves.
- Unknown errors, low confidence alone, stale labels, and retry exhaustion cannot manufacture human authority. Merge, release, deploy, secret, and override authority are never invented.

## Capabilities

### New Capabilities

- `typed-request-resolution`: shared recommend-and-commit classifier; closed three-member request union; evidence gathering; auto-settle predicate; DecisionRequest / CapabilityRequest / AuthorityRequest record shapes; five-way test distinction; candidate-epoch invalidation; false-human prohibition.

### Modified Capabilities

- `grill-with-docs-admission`: grill uses the shared classifier; a settled node records recommendation, rationale, alternatives, risk, and evidence.
- `grill-then-ready-refinement`: the Decisions artifact carries the same resolution package and remains the issue-body spec.
- `durable-blocker-classification`: `specification-decision` is only an irreducible `DecisionRequest` after the classifier; `missing-authority` is only a protected `AuthorityRequest`; missing information is not `specification-decision`.
- `durable-pause-and-authority`: waiting-request kinds `decision`, `answer`, and `authority-grant` map onto the public union; `answer` is a `CapabilityRequest` reason; product decisions are not authority grants.
- `human-question-handoff`: typed-request handoffs carry the required payload fields; candidate movement invalidates candidate-bound requests and grants.
- `autonomous-recovery-controller`: recovery runs the shared classifier before a human hold; auto-settle proceeds; capability and external-condition waits stay engine-owned.
- `loop-needs-human-blocker-disposition`: a `human-decision-required` diagnostic with category `product-decision` is not automatic authority; the classifier decides DecisionRequest vs auto-settle vs CapabilityRequest vs AuthorityRequest.

## Impact

- **Reuse first:** `core/scripts/grill-settle.ts` (`settleRecommendation`, `deriveSettlementSignals`), `TypedRequestKind` in `grill-decisions.ts`, `human-question-handoff.ts`, existing `DurableBlockerClass` members `specification-decision` and `missing-authority`, and RecoverySupervisor. Do not add a request type, a handoff CLI verb, a grant schema, or a second supervisor.
- **Classifier:** every path that today parks as `specification-decision`, `missing-authority`, `needs-human`, or `human-decision-required` MUST call the shared classifier. Path-local moles are incomplete.
- **Records:** extend `DecisionNode` and typed-request / handoff payloads. Keep `decisions.v1` unless a required field cannot be additive.
- **Projection:** `human-context-required` MUST NOT project to `specification-decision`. Missing information is a `CapabilityRequest`.
- **Tests:** injected I/O only. Distinguish reversible architectural choice, contradictory requirements, missing information, unavailable capability, and missing protected authority.
- **Packaging:** `node scripts/build.mjs` after any `core/` edit. `npm run ci` must pass.
- **Sequencing:** consumes #1324 candidate epochs for request/grant invalidation. Does not replace that reconcile work.

## Acceptance Criteria

- [ ] Decision resolution records recommendation, rationale, alternatives, risk, and evidence on the Decisions node or typed-request payload.
- [ ] A reversible in-scope policy-consistent already-authorized recommendation auto-settles under existing authority and does not create a handoff or human hold.
- [ ] A `CapabilityRequest` names the missing credential, permission, harness, information, or external condition, plus provider, the exact live probe, and the resume condition.
- [ ] A condition that can become true without supplied input becomes an external-condition wait, not a `CapabilityRequest` that asks a human.
- [ ] An `AuthorityRequest` binds eligible actor, repository, operation, scope, candidate epoch, evidence, and expiry, and never records a default grant.
- [ ] Candidate movement invalidates candidate-bound requests and grants.
- [ ] Unknown errors, low confidence alone, stale labels, and retry exhaustion do not create `DecisionRequest`, `AuthorityRequest`, or human-authority disposition.
- [ ] Tests distinguish reversible architectural choice, contradictory requirements, missing information, unavailable capability, and missing protected authority.
- [ ] Merge, release, deploy, secret, and override authority are never invented by auto-settle or model prose.
- [ ] `specification-decision` and `missing-authority` no longer share one terminal meaning: product decisions are not authority.
- [ ] Grill, advance, recovery, and ship use one classifier. A new site cannot park a human ask without that classifier.
- [ ] `npm run ci` passes.
