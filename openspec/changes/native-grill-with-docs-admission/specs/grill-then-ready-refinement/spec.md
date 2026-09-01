## REMOVED Requirements

### Requirement: Issue preview SHALL operate on one freshly fetched issue and SHALL write nothing

**Reason:** `pipeline refine-spec --issue` is no longer the intake controller. Admission is `pipeline grill`.
**Migration:** Run `pipeline grill --issue N`. Desk preview remains `pipeline refine-spec --title/--body`.

### Requirement: Issue preview SHALL invoke the Implementer once then the Reviewer once on the Decisions artifact only

**Reason:** The signed Implementer → Reviewer envelope is obsolete controller machinery. Grill auto-settles evidence-backed recommendations and emits typed requests.
**Migration:** Use `pipeline grill`. Do not require a Reviewer accept/challenge envelope before a body write.

### Requirement: Issue preview SHALL emit one bounded typed proposal

**Reason:** Operator-facing `grill-proposal.v1` stdout envelopes are not the admission protocol.
**Migration:** Grill writes the Decisions artifact directly. Existing envelopes are migrated or invalidated with diagnostics.

### Requirement: Apply SHALL consume the exact previewed proposal with no model call

**Reason:** `pipeline refine-spec apply` is not a permanent intake controller.
**Migration:** `pipeline grill --issue N` writes the body. Compatibility shims must not duplicate writes.

### Requirement: Apply SHALL refuse a proposal that contains any reviewer challenge

**Reason:** Reviewer `challenge` is no longer the pause signal. Typed requests replace it.
**Migration:** Irreducible pauses are `DecisionRequest`, `CapabilityRequest`, or `AuthorityRequest`.

### Requirement: Apply SHALL persist an authenticated canonical Decisions frontier

**Reason:** Operator-facing apply is removed. Engine-produced frontier persistence moves to `pipeline grill` body writes.
**Migration:** Grill persists the authenticated frontier when it writes the Decisions body. Ready validation still requires it.

### Requirement: Reviewer accept SHALL NOT settle operator-required classes

**Reason:** Broad authority classes are no longer mandatory handoffs when a recommendation is already covered by existing authority.
**Migration:** Auto-settle when the predicate passes. Emit `AuthorityRequest` only when protected action lacks existing authority.

### Requirement: Reviewer accept on taxonomy-validated non-authority SHALL record reviewer-accept provenance

**Reason:** Auto-settle provenance is `settled-by: auto-accept`. Reviewer-accept is not the admission default.
**Migration:** Ready validation accepts `auto-accept` for nodes that pass the auto-settle predicate. Existing `reviewer-accept` nodes remain valid provenance until re-grilled.

### Requirement: Apply SHALL supersede grill-authority handoffs that an applied refinement replaces

**Reason:** Apply is not the writer. Grill body writes supersede stale typed-request handoffs.
**Migration:** Grill performs the same supersede rule after a successful Decisions body write.

### Requirement: Grill-then-ready unit tests SHALL inject GitHub, dependency, harness, handoff, reviewer, clock, and drift seams

**Reason:** The locked test matrix moves to `grill-with-docs-admission`.
**Migration:** New unit tests inject GitHub, repository, model, clock, and filesystem I/O and cover the batch/auto-settle cases.

## MODIFIED Requirements

### Requirement: Pipeline SHALL validate authority class against a closed taxonomy

The model MAY propose a class. Pipeline SHALL accept a class only when it is a member of versioned closed taxonomy `grill-taxonomy.v1`. Operator-required members SHALL be: `scope`, `security`, `irreversible-operations`, `merge-release`, and `human-attestation`. Non-authority members SHALL be: `interface-contract`, `test-evidence`, `docs-surface`, and `operational-default`. An unknown or disputed class SHALL remain unresolved authority until classified or raised as a typed request. Taxonomy-validated nodes MAY auto-settle when the recommendation is reversible, in scope, policy-consistent, and covered by existing authority, with `settled-by: auto-accept` recorded. Auto-settle SHALL NOT grant merge, release, destructive, security, or other protected authority. A resolved node that lacks valid provenance SHALL fail validation.

#### Scenario: Unknown class stays unresolved

- **WHEN** the Implementer proposes class `invented-class`
- **THEN** Pipeline SHALL treat that node as unresolved authority
- **AND** SHALL NOT record `settled-by: auto-accept` for it

#### Scenario: Validated non-authority may take a default

- **WHEN** a node has a taxonomy-validated non-authority class and a recommended default
- **AND** the recommendation is reversible, in scope, policy-consistent, and covered by existing authority
- **THEN** grill SHALL write the body with that default and `settled-by: auto-accept`

#### Scenario: Covered recommendation may auto-settle

- **WHEN** a node has a taxonomy class and a recommended default that is reversible, in scope, policy-consistent, and covered by existing authority
- **THEN** grill SHALL write the body with that default and `settled-by: auto-accept`

#### Scenario: Resolved non-authority without reviewer-accept fails closed

- **WHEN** a Decisions artifact contains a taxonomy-validated non-authority node with `resolution: resolved` and `settled-by` other than `auto-accept`, `reviewer-accept`, or `handoff`
- **THEN** parse and `--stage ready` SHALL fail closed
- **AND** SHALL NOT treat the node as an automatic default

#### Scenario: Resolved node without provenance fails closed

- **WHEN** a Decisions artifact contains a resolved node with `settled-by` other than `auto-accept`, `reviewer-accept`, or `handoff`
- **THEN** parse and ready validation SHALL fail closed
- **AND** SHALL NOT treat the node as settled

---

### Requirement: Thin issues SHALL receive a canonical Decisions artifact and SHALL remain non-ready while authority is unresolved

When the input issue is thin or decision-incomplete, grill SHALL still produce a canonical Decisions artifact that lists unresolved typed requests. `pipeline grill` and `pipeline triage N --stage ready` SHALL refuse ready while any `DecisionRequest`, input-requiring `CapabilityRequest`, or protected `AuthorityRequest` is unresolved, or while typed dependency facts remain.

#### Scenario: Thin issue is not ready

- **WHEN** a thin issue is grilled with an unresolved `DecisionRequest`
- **THEN** the body SHALL contain a canonical Decisions artifact
- **AND** ready validation SHALL fail
- **AND** labels SHALL be unchanged by the ready path

---

### Requirement: Facts and dependencies SHALL use the existing grammar and a bounded closure

Grill SHALL read repository facts from the trusted integration-base revision and the exact issue context. Dependency extraction SHALL call `parseDeclaredDependencyIds` in `declared-dependency-grammar.ts`. Pipeline SHALL walk a versioned bounded dependency closure (max depth 8, max 32 issue ids). Grill, ready validation, and `pipeline triage --stage ready` SHALL call that same walker. Root declared-dependency edges SHALL be parsed from the proposed specification core before a body write, and from the applied specification core after the write. Pipeline SHALL NOT parse root edges from the pre-proposal body when a proposed or applied specification exists. Pipeline SHALL NOT parse root edges from the Pipeline-owned Decisions fence, the rendered Decisions section, or handoff provenance. The dependency-closure record SHALL NOT include the root issue in `ids` or `per_id`. Cycles, inaccessible or missing issues, malformed declarations, and closure-limit exhaustion SHALL be typed unresolved facts with codes `dependency.cycle`, `dependency.missing`, `dependency.inaccessible`, `dependency.malformed`, and `dependency.closure_exhausted`. Any unresolved fact with one of those codes SHALL fail ready validation with no label write. Pipeline SHALL NOT silently truncate the closure. Pipeline SHALL NOT invent a second dependency parser. Comments SHALL NOT become settled specification decisions.

#### Scenario: Cycle is a typed unresolved fact

- **WHEN** issue N declares a dependency cycle under the existing grammar
- **THEN** grill SHALL record a typed unresolved fact naming the cycle
- **AND** SHALL NOT drop edges to hide the cycle
- **AND** ready validation SHALL fail while that fact is unresolved
- **AND** labels SHALL be unchanged by the ready path

#### Scenario: Missing dependency is visible

- **WHEN** a declared dependency issue cannot be fetched
- **THEN** grill SHALL record a typed unresolved fact with code `dependency.missing` or `dependency.inaccessible`
- **AND** SHALL NOT invent a substitute issue body
- **AND** ready validation SHALL fail while that fact is unresolved

#### Scenario: Closure-limit exhaustion is visible

- **WHEN** walking declared dependencies exceeds the documented closure bound
- **THEN** grill SHALL record typed unresolved-fact exhaustion
- **AND** SHALL NOT silently omit remaining edges

#### Scenario: Proposed specification core supplies root edges before signing

- **WHEN** the proposed body adds, removes, or changes a declared dependency relative to the pre-grill body
- **THEN** grill SHALL compute the dependency-closure fingerprint from that proposed specification core before it writes the body
- **AND** SHALL NOT persist a closure computed from the pre-grill body

#### Scenario: Proposed specification core supplies root edges before the body write

- **WHEN** the proposed body adds, removes, or changes a declared dependency relative to the pre-grill body
- **THEN** grill SHALL compute the dependency-closure fingerprint from that proposed specification core before it writes the body
- **AND** SHALL NOT persist a closure computed from the pre-grill body

#### Scenario: Applied specification core supplies root edges at ready

- **WHEN** grill has written a Decisions body
- **AND** ready validation recomputes `dependency_closure_sha256`
- **THEN** ready SHALL parse root declared-dependency edges from the applied specification core
- **AND** SHALL NOT parse those edges from the Decisions fence, the rendered Decisions section, or handoff provenance

---

### Requirement: Required CONTEXT proposals SHALL block ready and SHALL NOT write repository files

When shared terminology required for implementation is missing, grill SHALL include a typed `CONTEXT.md` proposal. Grill SHALL write `CONTEXT.md` and qualifying ADRs only through a dedicated worktree and pull request as specified by `grill-with-docs-admission`. Grill SHALL NOT write those files on the integration branch. Pipeline SHALL classify each proposal as `required` or `advisory` from the integration-base `CONTEXT.md` blob and operator-required node `term_id` references. A model-written necessity field SHALL NOT survive that classification. A `required` proposal SHALL block ready until Pipeline records `required_context.integration_base_sha` and `required_context.context_md_sha256` from a trusted base whose blob contains every required term. Advisory context proposals SHALL NOT block ready. Model prose SHALL NOT set or clear those hashes.

#### Scenario: Required context blocks ready

- **WHEN** the artifact records a required CONTEXT change and no reviewed integration-base reference
- **THEN** ready validation SHALL fail
- **AND** labels SHALL be unchanged by the ready path
- **AND** the integration branch SHALL NOT have been written directly

#### Scenario: Advisory context does not block

- **WHEN** the artifact records only an advisory CONTEXT proposal
- **AND** all authority and fingerprint checks pass
- **THEN** ready promotion SHALL change only the stage label

#### Scenario: Model prose cannot force required context

- **WHEN** the Implementer marks a CONTEXT proposal `required`
- **AND** no unresolved typed request references a term missing from the integration-base `CONTEXT.md` blob
- **THEN** Pipeline SHALL store the proposal as `advisory`
- **AND** ready validation SHALL NOT block on that proposal

---

### Requirement: `triage --stage ready` SHALL validate the Decisions artifact with no model

`pipeline triage N --stage ready` SHALL re-fetch the issue and SHALL validate the Decisions artifact without invoking any model harness. `pipeline grill` SHALL call that same validator before any ready label write. It SHALL require: no unresolved typed request, no unresolved typed dependency facts (`dependency.cycle`, `dependency.missing`, `dependency.inaccessible`, `dependency.malformed`, `dependency.closure_exhausted`), valid authority provenance including `auto-accept` where the auto-settle predicate holds, render/artifact identity, required-context hashes that match the current trusted base blob, and current fingerprints for issue title, applied body, dependencies, integration base, required context, provider configuration, and resolved planning treatment. Any bound-input change SHALL make the artifact stale. Incomplete or stale artifacts SHALL exit 2 with no label change. A valid request SHALL add `pipeline:ready` first, remove other `pipeline:*` labels, re-fetch, and retry one remove pass if more than one `pipeline:*` remains. Persistent extras SHALL exit non-zero with `label_reconciliation_failed` and SHALL NOT remove `pipeline:ready`. `--stage backlog` SHALL remain a label write and SHALL NOT require a Decisions artifact. This gate SHALL NOT invoke the issue-implementation-readiness-gate model. Pickup of `pipeline:ready` SHALL still run that #1238 gate against fresh GitHub state.

#### Scenario: Incomplete artifact refuses ready

- **WHEN** the live body has an unresolved `AuthorityRequest`
- **AND** the operator runs `pipeline triage N --stage ready`
- **THEN** the command SHALL exit 2
- **AND** no pipeline stage label SHALL change
- **AND** no model harness SHALL be invoked

#### Scenario: Stale fingerprints refuse ready

- **WHEN** the integration-base revision or resolved planning treatment differs from the artifact fingerprints
- **THEN** `--stage ready` SHALL exit 2
- **AND** labels SHALL be unchanged

#### Scenario: Valid ready changes only the stage label

- **WHEN** the artifact is complete, provenanced, and fingerprint-current
- **AND** the operator runs `pipeline triage N --stage ready`
- **THEN** the issue SHALL carry `pipeline:ready` as its only `pipeline:*` label
- **AND** the body, title, milestone, and comments SHALL be unchanged
- **AND** no model harness SHALL be invoked

#### Scenario: Pickup still runs #1238

- **WHEN** grill or `--stage ready` has set `pipeline:ready`
- **AND** a later pickup path runs with `issue_readiness.enabled` true
- **THEN** that pickup SHALL run the shared issue-implementation-readiness gate
- **AND** SHALL NOT start a worktree or delivery harness unless that gate admits the fresh body

---

### Requirement: Operator answers SHALL use hash-bound `pipeline handoff answer` and SHALL materialize into the body

Pipeline SHALL extend the existing authenticated `pipeline handoff answer` boundary for pre-admission typed requests (`DecisionRequest`, input-requiring `CapabilityRequest`, and protected `AuthorityRequest`). It SHALL NOT create a second answer ledger or a new handoff CLI verb. It SHALL NOT create a handoff for an auto-settled node. Each handoff and answer SHALL bind repository, issue, node ID, frontier fingerprint, source body hash, and the canonical node-definition digest (id, question, recommendation, class, term_id). When no PR or worktree tip exists, `candidate_sha` MAY be omitted. Create for these nodes SHALL use a policy-bound authority gate whose evidence is that binding; it SHALL NOT weaken mid-flight human-decision-required SHA evidence. A successful answer SHALL deterministically patch that node in the issue body, record the handoff provenance reference, and keep render/artifact identity. Bound-hash drift SHALL exit 2 with no mutation. Spec-core equality SHALL NOT authorize a drifted full body. A live node whose definition digest does not match the bound digest SHALL fail closed. GitHub review comments and issue comments SHALL NOT settle nodes.

#### Scenario: Authenticated answer settles an operator-required node

- **WHEN** an eligible actor runs `pipeline handoff answer` for a bound `human-attestation` node
- **AND** the live body hash matches the handoff binding
- **THEN** the body node SHALL become resolved with that handoff provenance
- **AND** `settled-by: reviewer-accept` SHALL NOT be the authority record

#### Scenario: Authenticated answer settles an AuthorityRequest

- **WHEN** an eligible actor runs `pipeline handoff answer` for a bound `human-attestation` `AuthorityRequest`
- **AND** the live body hash matches the handoff binding
- **THEN** the body node SHALL become resolved with that handoff provenance
- **AND** `settled-by: auto-accept` SHALL NOT be the authority record

#### Scenario: Drift refuses materialize

- **WHEN** the live body hash differs from the handoff binding
- **THEN** the answer SHALL be refused
- **AND** the issue body SHALL be unchanged

#### Scenario: Artifact-only body edit refuses materialize

- **WHEN** the live body SHA-256 differs from the handoff binding because only the Decisions artifact or rendered `## Decisions` section changed
- **THEN** `pipeline handoff answer` SHALL exit 2
- **AND** the issue body SHALL be unchanged
- **AND** handoff status SHALL remain `pending`

#### Scenario: Successful materialize rebinds pending siblings

- **WHEN** a grill-authority answer writes a new issue body
- **THEN** remaining pending grill-authority handoffs for that issue SHALL bind the new body SHA-256
- **AND** the answered handoff SHALL keep the body hash it authorized

#### Scenario: Receipt-matching retry rebinds pending siblings

- **WHEN** a grill-authority answer writes the issue body
- **AND** pending sibling rebind then fails
- **AND** the live body still matches the recovery receipt
- **THEN** a later identical answer SHALL rebind remaining pending siblings to the recovered body
- **AND** SHALL persist the frontier only after that rebind succeeds
- **AND** SHALL NOT write the GitHub body a second time

#### Scenario: Receipt recovery does not replace a newer sibling frontier

- **WHEN** a grill-authority answer has written the issue body and persisted a recovery receipt
- **AND** a later identical answer rebinds a pending sibling to the recovered body
- **AND** that sibling then answers and persists a frontier for the later body before recovery persists
- **THEN** recovery SHALL NOT replace that later frontier with the recovered body
- **AND** the live body SHALL continue to match the later authenticated frontier

#### Scenario: Comment-only answer does not settle

- **WHEN** an operator comments the answer on the GitHub issue and does not run `pipeline handoff answer`
- **THEN** the node SHALL remain unresolved
- **AND** `--stage ready` SHALL exit 2

#### Scenario: Drift after a partial write refuses heal

- **WHEN** a grill-authority answer writes the issue body and then ledger persist fails
- **AND** an editor then changes the spec core and artifact fingerprint while retaining the target node definition and `handoff:<id>` reference
- **THEN** `pipeline handoff answer` SHALL exit 2
- **AND** the authenticated frontier SHALL be unchanged
- **AND** the handoff SHALL remain `pending`

---

### Requirement: ADR 0002 and CONTEXT.md SHALL name the grill, reviewer-accept provenance, and #1238 comments

`docs/adr/0002-decisions-live-in-the-issue-body.md` SHALL state that `pipeline grill` writes the body, that `triage --stage` never edits the body, that `auto-accept` is provenance of an in-scope default rather than operator authority, that remaining `reviewer-accept` nodes are historical provenance, and that #1238 comments are verdict evidence not the specification. Root `CONTEXT.md` SHALL remain glossary-only and SHALL define Grill, Decisions, Authority node, auto-accept, and typed requests in those terms. `CONTEXT.md` SHALL NOT treat a GitHub comment as a settled Decisions node. The ADR SHALL NOT retain a single-issue-only grill or a ban on repository-document writes.

#### Scenario: ADR no longer says triage rewrites the body

- **WHEN** a reader opens `docs/adr/0002-decisions-live-in-the-issue-body.md`
- **THEN** the ADR SHALL name `pipeline grill` as the grill writer
- **AND** SHALL NOT say that bare `pipeline triage N` rewrites the body

#### Scenario: ADR names pipeline grill as the writer

- **WHEN** a reader opens `docs/adr/0002-decisions-live-in-the-issue-body.md`
- **THEN** the ADR SHALL name `pipeline grill` as the grill writer
- **AND** SHALL NOT say that bare `pipeline triage N` rewrites the body
- **AND** SHALL NOT forbid repository-document writes through a docs PR

#### Scenario: Glossary distinguishes reviewer-accept from operator authority

- **WHEN** a reader opens root `CONTEXT.md`
- **THEN** Grill, Decisions, Authority node, and auto-accept SHALL be defined
- **AND** remaining `reviewer-accept` SHALL be described as historical provenance of a non-authority default, not operator authority

#### Scenario: Glossary distinguishes auto-accept from operator authority

- **WHEN** a reader opens root `CONTEXT.md`
- **THEN** Grill, Decisions, Authority node, and auto-accept SHALL be defined
- **AND** auto-accept SHALL be described as provenance of an in-scope default, not operator authority

---

### Requirement: Pipeline SHALL refresh a root-inclusive signed closure without new authority answers

When `pipeline grill --issue N` reads an applied Decisions artifact whose only stale fingerprint field is `dependency_closure_sha256`, Pipeline SHALL sign a root-exclusive `dependency_closure_sha256` from the current walker only when the recorded hash equals the legacy root-inclusive closure of an authenticated historical pre-proposal snapshot that was actually signed, together with the current declared-dependency snapshot. Pipeline SHALL obtain that snapshot from GitHub issue body revisions. Pipeline SHALL NOT treat the current applied specification core as that snapshot. If no such snapshot exists or none authenticates, grill SHALL use the normal grill flow. That authenticated refresh SHALL preserve existing nodes and settled provenance. Ready validation SHALL still compare fingerprints. It SHALL NOT skip the ready fingerprint check. It SHALL NOT add a ready-only dual-formula comparison.

#### Scenario: Root-inclusive pre-change artifact recovers

- **WHEN** an applied artifact records a root-inclusive `dependency_closure_sha256`
- **AND** the signed root body is a historical pre-proposal snapshot that differs from the applied specification core
- **AND** no bound input changed
- **AND** every typed request is already answered
- **AND** the operator runs `pipeline grill --issue N`
- **THEN** grill SHALL write a root-exclusive `dependency_closure_sha256`
- **AND** settled provenance SHALL remain
- **AND** ready validation SHALL succeed

#### Scenario: Applied specification core is not the historical snapshot

- **WHEN** an applied artifact records a root-inclusive `dependency_closure_sha256` signed from the pre-proposal body
- **AND** that pre-proposal body differs from the applied specification core
- **AND** no authenticated historical pre-proposal snapshot is available
- **AND** the operator runs `pipeline grill --issue N`
- **THEN** grill SHALL re-walk the design tree
- **AND** SHALL NOT treat the current applied specification core as the signed historical snapshot

#### Scenario: Real declared-dependency change does not use the migration shortcut

- **WHEN** an applied artifact's only stale fingerprint field is `dependency_closure_sha256`
- **AND** the recorded hash is not the legacy root-inclusive closure of an authenticated historical snapshot and the current declared-dependency snapshot
- **AND** the operator runs `pipeline grill --issue N`
- **THEN** grill SHALL re-walk the design tree
- **AND** SHALL NOT sign the live exclusive closure onto the existing settled artifact without that walk
