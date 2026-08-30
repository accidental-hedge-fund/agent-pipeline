## Purpose

Per-issue grill that looks up repository facts, records a versioned Decisions artifact in the GitHub issue body, lets the reviewer accept or challenge recommended defaults, and leaves operator-required authority to an authenticated handoff answer before a model-free `--stage ready` gate.

## ADDED Requirements

### Requirement: Issue preview SHALL operate on one freshly fetched issue and SHALL write nothing

`pipeline refine-spec --issue N` SHALL fetch the current title and body of issue N immediately before refinement. It SHALL operate on that one issue. It SHALL NOT use a milestone-level model response as issue authority. It SHALL NOT create, edit, label, or comment on any GitHub issue. It SHALL NOT write repository files, create branches, or push. Mixing `--issue` with `--title` or `--body` SHALL exit non-zero with a usage error and SHALL NOT invoke a harness.

#### Scenario: Preview fetches then writes nothing

- **WHEN** the operator runs `pipeline refine-spec --issue 42`
- **AND** the Implementer and Reviewer return valid output
- **THEN** the command SHALL emit one proposal
- **AND** SHALL NOT edit the issue body, title, milestone, labels, or comments
- **AND** SHALL NOT write any repository file

#### Scenario: Mixing issue and title/body is a usage error

- **WHEN** the operator runs `pipeline refine-spec --issue 42 --title "T" --body "B"`
- **THEN** the command SHALL exit non-zero with a usage error
- **AND** no harness call SHALL be made

#### Scenario: Milestone-level prompt is not used

- **WHEN** issue 42 declares dependencies and belongs to a milestone
- **THEN** preview SHALL refine issue 42 only
- **AND** SHALL NOT send a multi-issue or milestone-wide prompt as the issue's authority

---

### Requirement: Issue preview SHALL invoke the Implementer once then the Reviewer once on the Decisions artifact only

Issue preview SHALL invoke the resolved Implementer exactly once with the active planning treatment from required repository `pipeline.yml`: `harnesses.implementer`, `models.planning`, and `effort.planning`, including `auto` routing. After a valid Implementer proposal, it SHALL invoke the resolved Reviewer exactly once. The Reviewer input SHALL be the proposed Decisions artifact plus the input fingerprint. The Reviewer SHALL NOT receive a second copy of the whole-repository prompt. The Implementer SHALL NOT mark its own nodes `accept` or `settled-by: reviewer-accept`. Harness failure, timeout, malformed output, capability refusal, unavailable facts, or input drift SHALL exit non-zero with no body or label mutation.

#### Scenario: Two configured calls and no writes on success

- **WHEN** `pipeline refine-spec --issue N` runs to stdout emission
- **THEN** exactly one Implementer planning-treatment call SHALL have been made
- **AND** exactly one Reviewer call SHALL have been made
- **AND** the Reviewer prompt SHALL contain the Decisions artifact and input fingerprint
- **AND** the Reviewer prompt SHALL NOT contain a second full-repository copy of the Implementer prompt
- **AND** no GitHub write SHALL have been made

#### Scenario: Implementer cannot self-accept

- **WHEN** the Implementer output marks a node `settled-by: reviewer-accept` or `accept`
- **THEN** preview SHALL exit non-zero
- **AND** the Reviewer SHALL NOT be invoked
- **AND** the issue body SHALL be unchanged

#### Scenario: Harness failure mutates nothing

- **WHEN** the Implementer times out or returns malformed JSON
- **THEN** preview SHALL exit non-zero
- **AND** the Reviewer SHALL NOT be invoked
- **AND** no GitHub write or repository-file write SHALL have been made

---

### Requirement: Issue preview SHALL emit one bounded typed proposal

On success, issue preview SHALL write exactly one unfenced JSON object to stdout. That object SHALL be a `grill-proposal.v1` signed envelope: `schema_version`, `kind`, `issued_at`, `expires_at`, `nonce`, `repo`, `issue`, `input`, `proposal` (refined body, Decisions artifact, per-node reviewer verdicts, advisory title and milestone, typed CONTEXT proposals), and `mac`. Title and milestone fields SHALL be advisory. The MAC SHALL be HMAC-SHA256 over the canonical JSON of every field except `mac`, using the host-local grill proposal key. The envelope SHALL be size-bounded at 1 MiB UTF-8; content that exceeds the bound SHALL fail closed rather than silently truncate authority nodes. Preview SHALL NOT persist the envelope to GitHub, tracked files, or comments. Preview MAY create gitignored `.agent-pipeline/grill-proposal.key` when no key env/file exists.

#### Scenario: Successful preview is parseable JSON

- **WHEN** `pipeline refine-spec --issue N` succeeds
- **THEN** stdout SHALL be one JSON object
- **AND** the object SHALL include `mac`, `input`, and a `proposal` object with the refined body, Decisions artifact, reviewer verdicts, and input fingerprint
- **AND** stdout SHALL contain no surrounding prose or markdown fence

#### Scenario: Over-size proposal fails closed

- **WHEN** the assembled proposal would exceed the documented size bound
- **THEN** preview SHALL exit non-zero
- **AND** SHALL NOT emit a partial proposal that dropped authority nodes

---

### Requirement: Apply SHALL consume the exact previewed proposal with no model call

`pipeline refine-spec apply --issue N` SHALL read the signed envelope from stdin XOR `--proposal-file PATH`. It SHALL NOT accept a positional proposal token. Empty input, both stdin and `--proposal-file` present, or UTF-8 size above 1 MiB SHALL exit 2 with no mutation. Apply SHALL verify `mac`, schema version, `kind`, TTL, repo/issue binding, and challenge-free verdicts before any GitHub write. It SHALL consume that exact verified object. It SHALL NOT invoke any model harness. It SHALL re-fetch the current title and body and SHALL require them to match `input.title` and `input.body`. Drift, MAC failure, expiry, consumed nonce, or a forged verdict SHALL exit 2 with no mutation. Apply SHALL change only the issue body. Title, milestone, labels, comments, and project files SHALL remain unchanged. An active pipeline kill-switch SHALL block apply writes. Preview SHALL NOT be blocked solely because it shares the `refine-spec` keyword.

#### Scenario: Apply writes the previewed body

- **WHEN** apply receives a valid challenge-free proposal whose input title and body match the live issue
- **THEN** the issue body SHALL equal the proposal body
- **AND** no model harness SHALL have been invoked
- **AND** title, milestone, labels, and comments SHALL be unchanged

#### Scenario: Drift exits 2

- **WHEN** the live title or body differs from the proposal input identity
- **THEN** apply SHALL exit 2
- **AND** the issue body SHALL be unchanged

#### Scenario: Kill-switch blocks apply

- **WHEN** the kill-switch file is present
- **AND** the operator runs `pipeline refine-spec apply --issue N`
- **THEN** no GitHub body write SHALL occur

#### Scenario: Kill-switch does not block preview

- **WHEN** the kill-switch file is present
- **AND** the operator runs `pipeline refine-spec --issue N`
- **THEN** preview SHALL still run
- **AND** SHALL NOT write GitHub state

#### Scenario: Tampered envelope is refused

- **WHEN** apply receives an envelope whose `proposal` or verdicts were edited after preview
- **THEN** MAC verification SHALL fail
- **AND** apply SHALL exit 2
- **AND** the issue body SHALL be unchanged

#### Scenario: Expired or replayed envelope is refused

- **WHEN** apply receives a MAC-valid envelope past `expires_at`, or a nonce already recorded as consumed
- **THEN** apply SHALL exit 2
- **AND** the issue body SHALL be unchanged

#### Scenario: Empty or dual proposal input is a usage error

- **WHEN** apply runs with no stdin bytes and no `--proposal-file`
- **OR** with both stdin bytes and `--proposal-file`
- **THEN** the command SHALL exit 2
- **AND** no GitHub write SHALL occur

---

### Requirement: Apply SHALL refuse a proposal that contains any reviewer challenge

If any node in the proposal carries a reviewer verdict of `challenge`, apply SHALL exit 2, SHALL NOT write the body, and SHALL require a later preview.

#### Scenario: Reviewer challenges a recommended default

- **WHEN** a preview's Decisions artifact has an unsettled node
- **AND** the reviewer returns `challenge` for that node
- **AND** apply is invoked with that proposal
- **THEN** apply SHALL exit 2
- **AND** the body SHALL be unchanged
- **AND** a later preview SHALL be required before apply can succeed

---

### Requirement: The Decisions artifact SHALL be versioned, embedded, and the sole source of the readable Decisions section

Pipeline SHALL embed a versioned Pipeline-owned Decisions artifact in the issue body. Each stable node SHALL record its question, recommendation, authority class, resolution, provenance reference, and input digests. Pipeline SHALL render the readable `## Decisions` section from that same artifact. Divergence between the artifact and the rendered section SHALL fail validation at apply, handoff materialize, and `--stage ready`. The issue body SHALL remain the specification. Comments and handoffs MAY prove provenance. They SHALL NOT replace the body.

#### Scenario: Render matches artifact

- **WHEN** apply writes a body
- **THEN** the embedded artifact SHALL parse
- **AND** the `## Decisions` section SHALL equal the render of that artifact

#### Scenario: Divergent render fails ready

- **WHEN** the live body contains an artifact and a `## Decisions` section that do not match
- **THEN** `pipeline triage N --stage ready` SHALL exit 2
- **AND** labels SHALL be unchanged

#### Scenario: Comment is not the spec

- **WHEN** an issue comment states a decision that is absent from the body artifact
- **THEN** `--stage ready` SHALL NOT treat that comment as a settled node

#### Scenario: Duplicate or colliding fence fails validation

- **WHEN** the live body contains two `pipeline-decisions-v1` fences, or a digest that does not match the fence payload
- **THEN** apply, handoff materialize, and `--stage ready` SHALL fail closed
- **AND** labels and the body SHALL be unchanged on `--stage ready`

---

### Requirement: Pipeline SHALL validate authority class against a closed taxonomy

The model MAY propose a class. Pipeline SHALL accept a class only when it is a member of versioned closed taxonomy `grill-taxonomy.v1`. Operator-required members SHALL be: `scope`, `security`, `irreversible-operations`, `merge-release`, and `human-attestation`. Non-authority members SHALL be: `interface-contract`, `test-evidence`, `docs-surface`, and `operational-default`. An unknown or disputed class SHALL remain unresolved authority. Only taxonomy-validated non-authority nodes MAY take recommended defaults automatically, and the eligibility reason SHALL be recorded on the node. Non-authority automatic defaults SHALL NOT be applied without that taxonomy validation.

#### Scenario: Unknown class stays unresolved

- **WHEN** the Implementer proposes class `invented-class`
- **THEN** Pipeline SHALL treat that node as unresolved authority
- **AND** SHALL NOT record `settled-by: reviewer-accept` for it

#### Scenario: Validated non-authority may take a default

- **WHEN** a node has a taxonomy-validated non-authority class and a recommended default
- **AND** the Reviewer returns `accept`
- **THEN** apply SHALL write the body with that default and `settled-by: reviewer-accept`

---

### Requirement: Reviewer accept SHALL NOT settle operator-required classes

Reviewer `accept` on `scope`, `security`, `irreversible-operations`, `merge-release`, or `human-attestation` SHALL record that the recommendation was reviewed. The node SHALL stay unresolved until an authenticated hash-bound `pipeline handoff answer` for that node. `--stage ready` SHALL still exit 2 while that node is unresolved. Model-authored `settled-by` prose SHALL NOT authorize operator-required classes.

#### Scenario: Reviewer accepts an operator-required recommendation

- **WHEN** a human-attestation or merge/release authority node exists
- **AND** the reviewer returns `accept`
- **THEN** the node SHALL stay unresolved until `pipeline handoff answer`
- **AND** `--stage ready` SHALL exit 2
- **AND** labels SHALL be unchanged

#### Scenario: Model-authored provenance cannot self-authorize

- **WHEN** a body node for `scope` contains `settled-by: operator` written only by the model
- **AND** no matching authenticated handoff answer exists
- **THEN** `--stage ready` SHALL exit 2
- **AND** the node SHALL remain unresolved authority

---

### Requirement: Reviewer accept on taxonomy-validated non-authority SHALL record reviewer-accept provenance

`accept` on a taxonomy-validated non-authority node SHALL record `settled-by: reviewer-accept` as provenance of the automatic default. It SHALL NOT be treated as operator authority. That node SHALL NOT wait for a handoff.

#### Scenario: Reviewer accepts a non-authority default

- **WHEN** a taxonomy-validated non-authority node has a recommended default
- **AND** the reviewer returns `accept`
- **THEN** apply SHALL write the body with that default and `settled-by: reviewer-accept`
- **AND** SHALL NOT require `pipeline handoff answer` for that node

---

### Requirement: Thin issues SHALL receive a canonical Decisions artifact and SHALL remain non-ready while authority is unresolved

When the input issue is thin or decision-incomplete, issue preview SHALL still produce a canonical Decisions artifact that lists the unresolved operator-required nodes. Apply SHALL write that body when it contains no `challenge`. `pipeline triage N --stage ready` SHALL exit 2 until every operator-required node is resolved with valid authority provenance.

#### Scenario: Thin issue is not ready

- **WHEN** a thin issue is previewed and applied with unresolved `scope` nodes and no `challenge`
- **THEN** the body SHALL contain a canonical Decisions artifact
- **AND** `--stage ready` SHALL exit 2
- **AND** labels SHALL be unchanged

---

### Requirement: Facts and dependencies SHALL use the existing grammar and a bounded closure

Preview SHALL read repository facts from the trusted integration-base revision and the exact refinement context. Dependency extraction SHALL call `parseDeclaredDependencyIds` in `declared-dependency-grammar.ts`. Pipeline SHALL walk a versioned bounded dependency closure (max depth 8, max 32 issue ids). Cycles, inaccessible or missing issues, malformed declarations, and closure-limit exhaustion SHALL be typed unresolved facts with codes `dependency.cycle`, `dependency.missing`, `dependency.inaccessible`, `dependency.malformed`, and `dependency.closure_exhausted`. Any unresolved fact with one of those codes SHALL fail `--stage ready` with exit 2 and no label write. Pipeline SHALL NOT silently truncate the closure. Pipeline SHALL NOT invent a second dependency parser. Comments SHALL NOT become settled specification decisions.

#### Scenario: Cycle is a typed unresolved fact

- **WHEN** issue N declares a dependency cycle under the existing grammar
- **THEN** preview SHALL record a typed unresolved fact naming the cycle
- **AND** SHALL NOT drop edges to hide the cycle
- **AND** `--stage ready` SHALL exit 2 while that fact is unresolved
- **AND** labels SHALL be unchanged

#### Scenario: Missing dependency is visible

- **WHEN** a declared dependency issue cannot be fetched
- **THEN** preview SHALL record a typed unresolved fact with code `dependency.missing` or `dependency.inaccessible`
- **AND** SHALL NOT invent a substitute issue body
- **AND** `--stage ready` SHALL exit 2 while that fact is unresolved

#### Scenario: Closure-limit exhaustion is visible

- **WHEN** walking declared dependencies exceeds the documented closure bound
- **THEN** preview SHALL record typed unresolved-fact exhaustion
- **AND** SHALL NOT silently omit remaining edges

---

### Requirement: Required CONTEXT proposals SHALL block ready and SHALL NOT write repository files

When shared terminology required for implementation is missing, preview SHALL include a typed `CONTEXT.md` proposal in the envelope. Refinement SHALL NOT edit `CONTEXT.md` or any other repository file. Pipeline SHALL classify each proposal as `required` or `advisory` from the integration-base `CONTEXT.md` blob and operator-required node `term_id` references. A model-written necessity field SHALL NOT survive that classification. A `required` proposal SHALL block `--stage ready` until Pipeline records `required_context.integration_base_sha` and `required_context.context_md_sha256` from a trusted base whose blob contains every required term. Advisory context proposals SHALL NOT block ready. Model prose SHALL NOT set or clear those hashes.

#### Scenario: Required context blocks ready

- **WHEN** the artifact records a required CONTEXT change and no reviewed integration-base reference
- **THEN** `--stage ready` SHALL exit 2
- **AND** labels SHALL be unchanged
- **AND** no repository file SHALL have been written by refine-spec

#### Scenario: Advisory context does not block

- **WHEN** the artifact records only an advisory CONTEXT proposal
- **AND** all authority and fingerprint checks pass
- **THEN** `--stage ready` SHALL change only the stage label

#### Scenario: Model prose cannot force required context

- **WHEN** the Implementer marks a CONTEXT proposal `required`
- **AND** no operator-required node references a term missing from the integration-base `CONTEXT.md` blob
- **THEN** Pipeline SHALL store the proposal as `advisory`
- **AND** `--stage ready` SHALL NOT block on that proposal

---

### Requirement: `triage --stage ready` SHALL validate the Decisions artifact with no model

`pipeline triage N --stage ready` SHALL re-fetch the issue and SHALL validate the Decisions artifact without invoking any model harness. It SHALL require: no unresolved authority, no unresolved typed dependency facts (`dependency.cycle`, `dependency.missing`, `dependency.inaccessible`, `dependency.malformed`, `dependency.closure_exhausted`), valid authority provenance, render/artifact identity, required-context hashes that match the current trusted base blob, and current fingerprints for issue title, applied body, dependencies, integration base, required context, provider configuration, and resolved planning treatment. Any bound-input change SHALL make the artifact stale. Incomplete or stale artifacts SHALL exit 2 with no label change. A valid request SHALL add `pipeline:ready` first, remove other `pipeline:*` labels, re-fetch, and retry one remove pass if more than one `pipeline:*` remains. Persistent extras SHALL exit non-zero with `label_reconciliation_failed` and SHALL NOT remove `pipeline:ready`. `--stage backlog` SHALL remain a label write and SHALL NOT require a Decisions artifact. This gate SHALL NOT invoke the issue-implementation-readiness-gate model. Pickup of `pipeline:ready` SHALL still run that #1238 gate against fresh GitHub state.

#### Scenario: Incomplete artifact refuses ready

- **WHEN** the live body has unresolved operator-required nodes
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

- **WHEN** `--stage ready` has set `pipeline:ready`
- **AND** a later pickup path runs with `issue_readiness.enabled` true
- **THEN** that pickup SHALL run the shared issue-implementation-readiness gate
- **AND** SHALL NOT start a worktree or delivery harness unless that gate admits the fresh body

---

### Requirement: Operator answers SHALL use hash-bound `pipeline handoff answer` and SHALL materialize into the body

Pipeline SHALL extend the existing authenticated `pipeline handoff answer` boundary for pre-admission Decision nodes. It SHALL NOT create a second answer ledger or a new handoff CLI verb. Each handoff and answer SHALL bind repository, issue, node ID, frontier fingerprint, and source body hash. When no PR or worktree tip exists, `candidate_sha` MAY be omitted. Create for these nodes SHALL use a policy-bound authority gate whose evidence is that binding; it SHALL NOT weaken mid-flight human-decision-required SHA evidence. A successful answer SHALL deterministically patch that node in the issue body, record the handoff provenance reference, and keep render/artifact identity. Bound-hash drift SHALL exit 2 with no mutation, including when only the Decisions artifact or rendered section changed. Spec-core equality SHALL NOT authorize a drifted full body. After a successful materialize write, remaining pending sibling handoffs SHALL bind the new body hash. GitHub review comments and issue comments SHALL NOT settle nodes.

#### Scenario: Authenticated answer settles an operator-required node

- **WHEN** an eligible actor runs `pipeline handoff answer` for a bound `human-attestation` node
- **AND** the live body hash matches the handoff binding
- **THEN** the body node SHALL become resolved with that handoff provenance
- **AND** `settled-by: reviewer-accept` SHALL NOT be the authority record

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

#### Scenario: Comment-only answer does not settle

- **WHEN** an operator comments the answer on the GitHub issue and does not run `pipeline handoff answer`
- **THEN** the node SHALL remain unresolved
- **AND** `--stage ready` SHALL exit 2

---

### Requirement: Grill-then-ready unit tests SHALL inject GitHub, dependency, harness, handoff, reviewer, clock, and drift seams

Unit tests for issue preview, apply, handoff materialize, and `--stage ready` validation SHALL inject those I/O seams, plus git/base-resolution, filesystem, HMAC-key, and clock seams. No unit test SHALL perform a real network, git, or subprocess call. At least one test per refusal class (challenge, drift, self-accept, operator-required accept, stale fingerprint, comment-only answer, MAC tamper, expired envelope, consumed nonce, empty/dual/oversize proposal input, delimiter collision, required-context miss, typed dependency fact, label-reconciliation retry) SHALL fail against the pre-change behavior. Existing `core/test/refine-spec.test.ts` `--title/--body` cases SHALL keep passing, including the exact `{ title, body, milestone }` stdout shape.

#### Scenario: Injected tests cover refusal classes

- **WHEN** the grill-then-ready unit suite runs
- **THEN** it SHALL exercise challenge-refuse, drift-refuse, implementer-self-accept-refuse, operator-required-unresolved, stale-fingerprint-refuse, and comment-only-unsettled
- **AND** no test SHALL open a real GitHub, git, or subprocess call

---

### Requirement: ADR 0002 and CONTEXT.md SHALL name the grill, reviewer-accept provenance, and #1238 comments

`docs/adr/0002-decisions-live-in-the-issue-body.md` SHALL state that `refine-spec --issue` / `apply` write the body, that `triage --stage` never edits the body, that reviewer-accept is provenance not operator authority, and that #1238 comments are verdict evidence not the specification. Root `CONTEXT.md` SHALL remain glossary-only and SHALL define Grill, Decisions, Authority node, and reviewer-accept in those terms. `CONTEXT.md` SHALL NOT treat a GitHub comment as a settled Decisions node.

#### Scenario: ADR no longer says triage rewrites the body

- **WHEN** a reader opens `docs/adr/0002-decisions-live-in-the-issue-body.md`
- **THEN** the ADR SHALL name `refine-spec` as the grill writer
- **AND** SHALL NOT say that bare `pipeline triage N` rewrites the body

#### Scenario: Glossary distinguishes reviewer-accept from operator authority

- **WHEN** a reader opens root `CONTEXT.md`
- **THEN** Grill, Decisions, Authority node, and reviewer-accept SHALL be defined
- **AND** reviewer-accept SHALL be described as provenance of a non-authority default, not operator authority
