## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- `core/scripts/grill-settle.ts` — `settleRecommendation` and `deriveSettlementSignals`. Models propose. This predicate decides auto-accept vs typed request. Grill is the only caller today.
- `core/scripts/grill-decisions.ts` — `TypedRequestKind` is already `DecisionRequest | CapabilityRequest | AuthorityRequest`. `DecisionNode` records `question` and `recommendation` but not rationale, alternatives, risk, or evidence.
- `core/scripts/stage-diagnostic.ts` — `human-decision-required` projects to `specification-decision` + `human_authority`. `human-context-required` projects to `specification-decision` + `recover`. Both use the product-decision class.
- `core/scripts/loop-recovery.ts` — `specification-decision` and `missing-authority` both map to terminal `human_authority` with no recipes.
- `openspec/specs/durable-pause-and-authority/spec.md` — waiting kinds `decision`, `answer`, `authority-grant`. `answer` is the compatibility label for required information.
- `core/scripts/human-question-handoff.ts` — existing answer ledger. `pipeline handoff answer` remains the operator surface.
- RecoverySupervisor is the sole lifecycle owner. This change does not invent a second owner.

Engine-dogfood bar:

1. **Class, not site.** The class is false-human projection: product decisions, missing information, unavailable capability, and protected authority collapse into similar terminal human ownership.
2. **Shared law.** Classifier, stage-diagnostic projection, durable-class meaning, and request/grant records change together. A path-local mole at one park site is incomplete.
3. **Next identical fault.** A new site that wants a human ask MUST call the shared classifier. Classifier tests distinguish the five cases, so a new mole issue is not required.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: export and call `settleRecommendation` from recovery, advance, and ship. Do not write a second classifier.
- Separate product decisions, unavailable information, absent capability, and protected authority before any human ask.
- Record a recommendation package, then auto-settle when the existing auto-accept predicate holds.
- Keep `pipeline handoff answer` as the only answer surface.

**Non-Goals:**

- A fourth public request type.
- A new handoff CLI verb, grant schema, or RecoverySupervisor.
- Replacing repository policy with model preference.
- Treating every architecture choice as human-only.
- Auto-granting merge, release, deploy, secret, or override authority.
- Replacing #1324 candidate-epoch / reconcile work.

## Decisions

### D1 — One shared classifier, grill-settle is the rung

Keep `settleRecommendation` as the engine-owned predicate. Call it from grill, recovery, advance, and ship before any `DecisionRequest`, `CapabilityRequest`, `AuthorityRequest`, `specification-decision`, or `missing-authority` outcome.

Do not add `typed-request-resolver.ts` as a parallel policy. A thin shared wrapper that records the resolution package and maps durable-pause aliases is allowed only if it calls this predicate.

Alternative considered: a new classifier module owned by RecoverySupervisor. Rejected: grill already has the fail-closed protected-action and trusted-fact coverage rules. A second copy will drift.

### D2 — Public union stays three members; pause kinds are aliases

Public typed-request union remains `DecisionRequest | CapabilityRequest | AuthorityRequest`.

Map durable-pause kinds:

| Compatibility kind | Public type |
| --- | --- |
| `decision` | `DecisionRequest` |
| `answer` | `CapabilityRequest` (required information is a reason, not a fourth type) |
| `authority-grant` | `AuthorityRequest` |

Keep accepting the three pause-kind strings so existing ledgers parse. Project them onto the public union at classify and resume time. Product `decision` is not `authority-grant`.

Alternative considered: replace pause kinds with the public names. Rejected: that is a ledger break. Alias mapping is the first holding rung.

### D3 — Resolution package is additive on the Decisions node

Each settled or requested decision node SHALL record recommendation, rationale, alternatives, risk, and evidence.

Keep `decisions.v1`. Add optional-then-required fields on the node. Do not put rationale, alternatives, risk, or evidence into the definition digest (`id`, `question`, `recommendation`, `class`, `term_id`). Definition-digest stability stays the authority binding for handoff materialize.

A missing package on a new resolution fails closed. Existing bodies without the new fields remain parseable until the next grill or classifier rewrite of that node.

Alternative considered: `decisions.v2`. Rejected unless additive parse cannot preserve existing bodies. Prefer additive fields.

### D4 — Gather facts, then recommend, then classify

Before a human ask, gather repository, issue, forge, runtime, and policy evidence using the existing grill facts path and #1324 observers. Models do not ask for a discoverable fact.

Then commit a recommendation. Then run the auto-settle predicate. Low confidence alone does not change the class.

Auto-settle proceeds only when all of these are true:

- reversible
- in current scope
- policy-consistent
- already authorized by trusted facts
- not contradicted by authoritative evidence

Fail closed when coverage cannot be proven. Model-written `covered_by_existing_authority` is not proof.

### D5 — Projection split: context is not specification-decision

`human-context-required` SHALL NOT project to `specification-decision`. Missing information is a `CapabilityRequest` when input is required, or an external-condition wait when the condition can become true without input.

`human-decision-required` with category `product-decision` SHALL run the classifier:

- auto-settle → no hold
- contradictory / irreducible product choice → `DecisionRequest` / `specification-decision`
- missing information or capability → `CapabilityRequest` (not human_authority)
- protected action without existing authority → `AuthorityRequest` / `missing-authority`

`human-decision-required` with category `authority` remains `AuthorityRequest` / `missing-authority` and never defaults.

`specification-decision` and `missing-authority` keep empty recipe lists. They still have no retry recipes. They no longer share one meaning.

### D6 — CapabilityRequest names probe and resume; AuthorityRequest never defaults

`CapabilityRequest` records missing capability or information, provider, exact live probe, and resume condition. A condition that can become true without supplied input is an external-condition wait, not a human `CapabilityRequest`.

`AuthorityRequest` records eligible actor, repository, operation, scope, candidate epoch, evidence, and expiry. Empty actor, missing expiry, or missing candidate epoch when a tip exists fails closed. Auto-settle never writes an `AuthorityRequest` default.

Merge, release, deploy, secret, and override authority are never invented.

### D7 — Candidate epoch invalidates requests and grants

Reuse #1324 candidate movement as the epoch. When the candidate SHA or epoch changes, candidate-bound `DecisionRequest`, `CapabilityRequest`, `AuthorityRequest`, and authority grants become invalid. Resume re-runs the classifier against current facts. A leftover `pipeline:blocked` label does not preserve stale authority.

Pre-admission grill-authority handoffs that bound issue body hash rather than a PR tip keep the existing body-hash gate. Candidate-epoch invalidation applies when a candidate tip exists.

### D8 — Five classifier tests are the class guard

Unit tests at the shared classifier, with injected facts and no network/git/subprocess, MUST distinguish:

1. reversible architectural choice → auto-settle
2. contradictory requirements → `DecisionRequest`
3. missing information → `CapabilityRequest`
4. unavailable capability that needs input → `CapabilityRequest`; external-condition wait when no input is required
5. missing protected authority → `AuthorityRequest`

Unknown errors, low confidence alone, stale labels, and retry exhaustion MUST NOT produce cases 2 or 5.

A site that parks without calling the classifier fails a static or seam test.

## Risks / Trade-offs

- **Existing recovery tests expect `specification-decision` → immediate human_authority.** → Update those tests to feed the classifier. Keep immediate human_authority only for an irreducible `DecisionRequest` or a protected `AuthorityRequest`.
- **Additive `decisions.v1` fields vs version bump.** → Parse old bodies. Require the package on newly written resolutions. Bump only if parse cannot stay compatible.
- **Over-auto-settle of a real product conflict.** → Contradictory signals stay `DecisionRequest`. Trusted-fact contradiction blocks auto-settle. Fail closed when coverage is unproven.
- **Compatibility labels keep saying `answer` and `product-decision`.** → Alias map is documented and tested. Public union and durable class meaning are the authority.

## Migration Plan

1. Extend DecisionNode / typed-request records additively.
2. Point recovery, advance, and ship at `settleRecommendation` before any human park.
3. Change `human-context-required` projection.
4. Re-classify in-flight `specification-decision` holds on resume through the classifier.
5. Keep existing handoff answer and pause-kind strings.

Rollback: revert the projection and caller wiring. Additive record fields remain backward compatible.

## Open Questions

None. Issue #1326 already locked the public union, auto-settle predicate, CapabilityRequest shape, and AuthorityRequest binding.
