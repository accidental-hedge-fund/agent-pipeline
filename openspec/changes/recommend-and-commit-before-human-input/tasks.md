## 1. Shared classifier tests

- [x] 1.1 Add injected-I/O classifier fixtures for reversible architectural choice, contradictory requirements, missing information, unavailable capability, and missing protected authority, and verify the five cases currently fail or disagree at the recovery/advance seam
- [x] 1.2 Add fixtures that unknown errors, low confidence alone, stale labels, and retry exhaustion do not emit `DecisionRequest` or `AuthorityRequest`, and verify those fixtures fail if human authority is manufactured
- [x] 1.3 Add a fixture that an external condition which can become true without supplied input is a wait, not a human `CapabilityRequest`, and verify the test fails if that case parks as `specification-decision`

## 2. Resolution records

- [x] 2.1 Extend the Decisions node so a newly written resolution records recommendation, rationale, alternatives, risk, and evidence without putting those fields in the definition digest, and verify parse accepts existing bodies and rejects a new resolution that omits the package
- [x] 2.2 Extend `CapabilityRequest` records and handoffs to require missing capability or information, provider, live probe, and resume condition, and verify an incomplete record fails closed
- [x] 2.3 Extend `AuthorityRequest` records and handoffs to bind eligible actor, repository, operation, scope, candidate epoch, evidence, and expiry with no default grant, and verify an incomplete record fails closed
- [x] 2.4 Map durable-pause kinds `decision`, `answer`, and `authority-grant` onto the public union, and verify `answer` is a `CapabilityRequest` and `decision` is not `authority-grant`

## 3. Projection and auto-settle

- [x] 3.1 Call the existing `settleRecommendation` classifier from recovery, advance, and ship before any human park, and verify a reversible in-scope authorized recommendation auto-settles instead of `specification-decision`
- [x] 3.2 Change `human-context-required` so missing information is a `CapabilityRequest` or external-condition wait, and verify it no longer projects to `specification-decision` or `missing-authority`
- [x] 3.3 Keep `specification-decision` as the durable class only for an irreducible `DecisionRequest` after the classifier, and verify contradictory requirements still park with no retry recipe
- [x] 3.4 Keep `missing-authority` as the durable class only for a protected `AuthorityRequest`, and verify merge, release, deploy, secret, and override recommendations never auto-settle
- [x] 3.5 Update recovery-policy tests so `specification-decision` and `missing-authority` no longer share one terminal meaning, and verify product decisions are not treated as authority grants

## 4. Candidate epoch and resume

- [x] 4.1 Invalidate candidate-bound requests and grants when the candidate SHA or epoch moves, and verify resume refuses the stale answer
- [x] 4.2 Re-run the classifier on resume after invalidation, and verify a leftover `pipeline:blocked` label does not restore the prior grant
- [x] 4.3 Re-classify in-flight `specification-decision` holds through the classifier, and verify an auto-settleable hold is released without a human answer

## 5. Site wiring and class guard

- [x] 5.1 Route `human-decision-required` with category `product-decision` through the classifier in RecoverySupervisor and loop needs-human disposition, and verify auto-settle skips the hold
- [x] 5.2 Keep `pipeline handoff answer` as the only answer surface for remaining typed requests, and verify no second ledger or new handoff verb is added
- [x] 5.3 Add a seam or static guard that production park sites for human asks call the shared classifier, and verify a synthetic bypass fixture fails that guard

## 6. Docs, packaging, and CI

- [x] 6.1 Align `CONTEXT.md` Decision request / Capability request / Authority request glossary with recommend-and-commit and the three-member public union, and verify those entries no longer treat product decisions as authority
- [x] 6.2 After any `core/` edit run `node scripts/build.mjs` and refresh generated docs if the generator is present, and verify `node scripts/build.mjs --check` passes
- [x] 6.3 Run `openspec validate recommend-and-commit-before-human-input` and `openspec validate --all`, and verify both exit 0
- [x] 6.4 Run `npm run ci` from the repo root, and verify the full gate passes
