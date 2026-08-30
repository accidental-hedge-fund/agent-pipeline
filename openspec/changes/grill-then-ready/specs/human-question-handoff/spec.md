## ADDED Requirements

### Requirement: Pre-admission Decision nodes SHALL reuse `pipeline handoff answer` with a policy-bound grill-authority gate

Pipeline SHALL represent operator-required pre-admission Decision nodes as human-question handoffs answered through the existing `pipeline handoff answer` surface. It SHALL NOT add a second answer ledger or a new handoff CLI verb. Create for those nodes SHALL use a policy-bound authority gate whose evidence is repository, issue, node ID, frontier fingerprint, and source body hash. When no PR or worktree tip exists, create SHALL allow `candidate_sha` to be omitted. This gate SHALL NOT replace or weaken mid-flight human-decision-required evidence that binds a reviewed SHA. Model-written `settled-by` prose and reviewer-accept SHALL NOT satisfy these handoffs.

#### Scenario: Create succeeds without a PR tip

- **WHEN** create is requested for a `human-attestation` Decisions node on an issue with no PR or worktree tip
- **AND** repository, issue, node ID, frontier fingerprint, and source body hash are present
- **THEN** a pending authority-bearing handoff SHALL be persisted
- **AND** `candidate_sha` MAY be null

#### Scenario: Mid-flight HDR path is unchanged

- **WHEN** create is requested for a mid-flight `product_judgment` handoff with no HDR diagnostic and no policy-bound gate other than grill-authority
- **THEN** create SHALL fail closed as specified by the existing HDR requirement
- **AND** grill-authority evidence SHALL NOT substitute for a reviewed SHA on that mid-flight path

#### Scenario: Reviewer-accept does not answer the handoff

- **WHEN** a pending grill-authority handoff exists for a `scope` node
- **AND** the Decisions artifact records reviewer `accept` on that node
- **THEN** the handoff status SHALL remain `pending`
- **AND** `--stage ready` SHALL treat the node as unresolved

---

### Requirement: A successful grill-authority answer SHALL materialize into the issue body

When an eligible authenticated actor answers a pending grill-authority handoff, Pipeline SHALL re-fetch the issue body, SHALL require the live body hash to match the handoff binding, and SHALL deterministically patch only that node in the embedded Decisions artifact (resolution, provenance reference, and derived `## Decisions` render). Bound-hash drift SHALL refuse the answer with no body mutation. GitHub comments SHALL NOT perform this materialize. The item SHALL NOT transition to `pipeline:ready` solely because the answer was recorded; `--stage ready` remains a separate deterministic request.

#### Scenario: Matching hash materializes the node

- **WHEN** an eligible actor answers a pending grill-authority handoff
- **AND** the live body hash matches the binding
- **THEN** the matching Decisions node SHALL become resolved with that handoff provenance
- **AND** the rendered `## Decisions` section SHALL match the updated artifact
- **AND** other nodes SHALL be unchanged

#### Scenario: Body drift refuses the answer

- **WHEN** the live body hash differs from the handoff binding
- **THEN** the answer SHALL be refused
- **AND** the issue body SHALL be unchanged
- **AND** handoff status SHALL remain `pending`

#### Scenario: Answer does not flip ready

- **WHEN** a grill-authority answer materializes successfully
- **THEN** Pipeline SHALL NOT add `pipeline:ready` as a side effect of the answer

---

### Requirement: Grill-authority create and answer SHALL use a documented failure order

Apply SHALL create one pending grill-authority handoff per unresolved operator-required node after envelope verification and before the GitHub body write. Create SHALL bind repository, issue, node ID, frontier fingerprint, and the proposed-body SHA-256. Create SHALL be idempotent on `declaration_identity`. The operator surface SHALL remain `pipeline handoff answer <handoff-id> --issue N --text "…"`. Body-hash drift during answer SHALL leave the GitHub body unchanged and the handoff `pending`. A GitHub body-write failure during materialize SHALL leave the handoff `pending`. A ledger persist failure after a successful body write SHALL leave the body patched and the handoff `pending`; a later identical answer SHALL heal the ledger without a second body write when the live node already carries that handoff provenance.

#### Scenario: Create happens on apply before the body write

- **WHEN** apply verifies a challenge-free envelope with unresolved operator-required nodes
- **THEN** one pending handoff SHALL exist per such node before the GitHub body write is attempted
- **AND** preview SHALL NOT have created those records

#### Scenario: Body-write failure leaves the ledger pending

- **WHEN** answer authorization and body-hash checks pass
- **AND** the GitHub body write then fails
- **THEN** handoff status SHALL remain `pending`
- **AND** the live issue body SHALL be unchanged

#### Scenario: Duplicate answer is idempotent

- **WHEN** an eligible actor repeats `pipeline handoff answer` with the same payload hash or `--client-request-id`
- **AND** the handoff is already `answered`
- **THEN** the command SHALL succeed as a duplicate
- **AND** SHALL NOT rewrite the prior answer body
- **AND** SHALL NOT add `pipeline:ready`
