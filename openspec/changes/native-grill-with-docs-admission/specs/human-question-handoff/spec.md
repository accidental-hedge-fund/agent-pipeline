## MODIFIED Requirements

### Requirement: Pre-admission Decision nodes SHALL reuse `pipeline handoff answer` with a policy-bound grill-authority gate

Pipeline SHALL represent unresolved pre-admission typed requests (`DecisionRequest`, input-requiring `CapabilityRequest`, and protected `AuthorityRequest`) as human-question handoffs answered through the existing `pipeline handoff answer` surface. It SHALL NOT add a second answer ledger or a new handoff CLI verb. It SHALL NOT create a handoff for a node that auto-settled under existing authority. Create for those typed-request nodes SHALL use a policy-bound authority gate whose evidence is repository, issue, node ID, frontier fingerprint, and source body hash. When no PR or worktree tip exists, create SHALL allow `candidate_sha` to be omitted. This gate SHALL NOT replace or weaken mid-flight human-decision-required evidence that binds a reviewed SHA. Model-written `settled-by` prose and `auto-accept` SHALL NOT satisfy an `AuthorityRequest` that lacks existing authority.

#### Scenario: Create succeeds without a PR tip

- **WHEN** create is requested for a `human-attestation` `AuthorityRequest` on an issue with no PR or worktree tip
- **AND** repository, issue, node ID, frontier fingerprint, and source body hash are present
- **THEN** a pending authority-bearing handoff SHALL be persisted
- **AND** `candidate_sha` MAY be null

#### Scenario: Mid-flight HDR path is unchanged

- **WHEN** create is requested for a mid-flight `product_judgment` handoff with no HDR diagnostic and no policy-bound gate other than grill-authority
- **THEN** create SHALL fail closed as specified by the existing HDR requirement
- **AND** grill-authority evidence SHALL NOT substitute for a reviewed SHA on that mid-flight path

#### Scenario: Reviewer-accept does not answer the handoff

- **WHEN** a pending grill-authority handoff exists for a `scope` node
- **AND** the Decisions artifact records reviewer `accept` or `settled-by: auto-accept` on that node without a matching handoff answer
- **THEN** the handoff status SHALL remain `pending`
- **AND** `--stage ready` SHALL treat the node as unresolved

#### Scenario: Auto-accept does not answer an AuthorityRequest

- **WHEN** a pending grill-authority handoff exists for a protected `scope` node that lacked existing authority
- **AND** the Decisions artifact records `settled-by: auto-accept` on that node without a matching handoff answer
- **THEN** the handoff status SHALL remain `pending`
- **AND** ready validation SHALL treat the node as unresolved

#### Scenario: Covered scope does not create a handoff

- **WHEN** a `scope` recommendation is already covered by existing issue-body authority
- **THEN** grill SHALL NOT create a grill-authority handoff for that node

---

### Requirement: Grill-authority create and answer SHALL use a documented failure order

Grill SHALL create one pending grill-authority handoff per unresolved typed request after settlement classification and before the GitHub body write. Create SHALL bind repository, issue, node ID, frontier fingerprint, and the proposed-body SHA-256. Create SHALL be idempotent on `declaration_identity`. The operator surface SHALL remain `pipeline handoff answer <handoff-id> --issue N --text "…"`. Body-hash drift during answer SHALL leave the GitHub body unchanged and the handoff `pending`. A GitHub body-write failure during materialize SHALL leave the handoff `pending`. Before a GitHub body write, Pipeline SHALL persist a Pipeline-authenticated recovery receipt for the exact expected body. A ledger persist failure after a successful body write SHALL leave the body patched and the handoff `pending`. A later identical answer SHALL heal the ledger without a second body write only when the live node already carries that handoff provenance AND the live full-body SHA-256 matches that receipt. That heal SHALL rebind remaining pending sibling handoffs to the recovered body and SHALL persist the next frontier only after that rebind succeeds. Pipeline SHALL NOT persist a replacement frontier or record the answer when the live body does not match the receipt, including when the target node definition and `handoff:<id>` reference remain.

#### Scenario: Create happens on apply before the body write

- **WHEN** grill classifies unresolved typed requests
- **THEN** one pending handoff SHALL exist per such request before the GitHub body write is attempted
- **AND** auto-settled nodes SHALL NOT have those records

#### Scenario: Create happens on grill before the body write

- **WHEN** grill classifies unresolved typed requests
- **THEN** one pending handoff SHALL exist per such request before the GitHub body write is attempted
- **AND** auto-settled nodes SHALL NOT have those records

#### Scenario: Body-write failure leaves the ledger pending

- **WHEN** answer authorization and body-hash checks pass
- **AND** the GitHub body write then fails
- **THEN** handoff status SHALL remain `pending`
- **AND** the live issue body SHALL be unchanged

#### Scenario: Receipt-matching retry heals without a second write

- **WHEN** a grill-authority answer writes the issue body and then ledger persist fails
- **AND** the live body still matches the recovery receipt
- **THEN** a later identical answer SHALL record the handoff as answered
- **AND** SHALL NOT write the GitHub body a second time

#### Scenario: Receipt-matching retry rebinds pending siblings

- **WHEN** a grill-authority answer writes the issue body
- **AND** pending sibling rebind then fails
- **AND** the live body still matches the recovery receipt
- **THEN** a later identical answer SHALL rebind remaining pending siblings to the recovered body
- **AND** SHALL persist the frontier only after that rebind succeeds
- **AND** SHALL NOT write the GitHub body a second time

#### Scenario: Drift after a partial write refuses heal

- **WHEN** a grill-authority answer writes the issue body and then ledger persist fails
- **AND** an editor then changes the spec core and artifact fingerprint while retaining the target node definition and `handoff:<id>` reference
- **THEN** a later identical answer SHALL be refused
- **AND** the authenticated frontier SHALL be unchanged
- **AND** the handoff SHALL remain `pending`

#### Scenario: Duplicate answer is idempotent

- **WHEN** an eligible actor repeats `pipeline handoff answer` with the same payload hash or `--client-request-id`
- **AND** the handoff is already `answered`
- **THEN** the command SHALL succeed as a duplicate
- **AND** SHALL NOT rewrite the prior answer body
- **AND** SHALL NOT add `pipeline:ready`
