## Purpose

Native, versioned grill-with-docs-to-ready admission: select open issues, walk each design tree, auto-settle in-scope recommendations, record spec and domain docs, and request pipeline:ready without a host skill or a second intake controller.

## ADDED Requirements

### Requirement: The pipeline CLI SHALL accept `grill` as one no-issue-number admission operation

The pipeline CLI SHALL recognize `grill` as a positional sub-command keyword that does not take a positional issue number and does not enter the advance loop. Exactly one selector form SHALL be required: `--issue N`, `--issues N,N,...`, `--milestone M`, or one or more `--label L` filters. Mixing two selector forms SHALL exit 2 with a usage error and SHALL NOT invoke a harness or write GitHub state. Repeated `--label` values SHALL mean AND intersection. `--dry-run`, `--json`, `--follow`, `--resume <run-id>`, and the `status` sub-verb SHALL be accepted on this operation. The CLI SHALL NOT shell out to a host Skill tool, a personal Codex skill, or mattpocock/skills.

#### Scenario: Single-issue selector dispatches grill

- **WHEN** the operator runs `pipeline grill --issue 42`
- **THEN** the CLI SHALL dispatch the grill handler
- **AND** SHALL NOT start the advance loop for issue 42

#### Scenario: Mixed selectors are a usage error

- **WHEN** the operator runs `pipeline grill --issue 42 --milestone v1.40.1`
- **THEN** the command SHALL exit 2 with a usage error
- **AND** no GitHub write SHALL occur
- **AND** no harness call SHALL be made

#### Scenario: Repeated labels intersect

- **WHEN** the operator runs `pipeline grill --label a --label b`
- **THEN** selection SHALL include only open issues that carry both labels

#### Scenario: Host skill is not a runtime dependency

- **WHEN** `pipeline grill --issue 42` runs
- **THEN** the process SHALL NOT exec a host Skill tool or mattpocock/skills path

---

### Requirement: Grill SHALL freeze a versioned sorted selection manifest before the first write

Grill SHALL resolve the selector once into a frozen, versioned manifest of open issue ids sorted ascending, plus selector identity and the trusted integration-base SHA, before any issue-body, label, handoff, or repository-file write. Closed issues encountered at resolve time SHALL be reported as ineligible and SHALL never be relabeled. After freeze, later milestone or label membership changes SHALL NOT add or drop members of that run. `--resume` SHALL reload the frozen manifest and SHALL NOT re-query selector membership.

#### Scenario: Milestone drift does not change a running batch

- **WHEN** a run frozen for `--milestone v1.40.1` contains issues 10 and 11
- **AND** issue 12 is later added to that milestone
- **AND** the operator resumes that run
- **THEN** the resumed run SHALL still contain only 10 and 11
- **AND** SHALL NOT add 12

#### Scenario: Closed issues are ineligible

- **WHEN** `--issues 10,11` includes closed issue 11
- **THEN** issue 11 SHALL be reported as ineligible
- **AND** grill SHALL NOT add, remove, or replace any label on issue 11

---

### Requirement: Single-issue and batch execution SHALL share one per-issue state machine

`pipeline grill --issue N` and any batch selector SHALL run the same per-issue state machine and the same auto-settle, typed-request, documentation, and ready-gate rules. A batch SHALL order work by declared dependencies, process every currently unblocked issue, isolate per-issue failure, and continue dependency-independent issues. Grill SHALL NOT enqueue items into the pipeline loop supervisor.

#### Scenario: One issue and a list use the same settlement rules

- **WHEN** issue 10 auto-settles a reversible in-scope recommendation under `--issue 10`
- **AND** the same issue is later a member of `--issues 10,11`
- **THEN** that recommendation SHALL be eligible for the same auto-settle rule in both runs

#### Scenario: Independent peer continues after a sibling failure

- **WHEN** a batch contains independent issues 10 and 11
- **AND** issue 10 fails
- **THEN** grill SHALL continue issue 11
- **AND** SHALL record issue 10 as failed in the batch report

#### Scenario: Declared dependency waits

- **WHEN** issue 11 declares a dependency on issue 10
- **AND** both are in the frozen manifest
- **AND** issue 10 is not yet grilled
- **THEN** grill SHALL NOT promote issue 11 before issue 10 has completed or failed
- **AND** SHALL use the existing declared-dependency grammar rather than a second parser

---

### Requirement: Grill SHALL gather facts from repository, forge, configuration, and declared dependencies

Grill SHALL re-fetch each issue’s current title, body, and labels immediately before evaluation. Facts SHALL come from the trusted integration-base revision, GitHub, repository configuration, and declared dependencies. Models SHALL NOT ask the operator for a discoverable fact. Dependency extraction SHALL call the existing declared-dependency grammar and the existing bounded closure walker (max depth 8, max 32 issue ids). Cycles, missing or inaccessible issues, malformed declarations, and closure-limit exhaustion SHALL be typed unresolved facts with codes `dependency.cycle`, `dependency.missing`, `dependency.inaccessible`, `dependency.malformed`, and `dependency.closure_exhausted`. Grill SHALL NOT silently truncate the closure. Comments SHALL NOT become settled specification decisions.

#### Scenario: Discoverable fact is not an operator question

- **WHEN** a frontier question can be answered from the integration-base tree or GitHub issue state
- **THEN** grill SHALL record that fact
- **AND** SHALL NOT create a typed request for that fact

#### Scenario: Cycle remains a typed unresolved fact

- **WHEN** issue N declares a dependency cycle under the existing grammar
- **THEN** grill SHALL record a typed unresolved fact naming the cycle
- **AND** SHALL NOT promote that issue to `pipeline:ready` while the fact is unresolved

---

### Requirement: Grill SHALL walk each issue design tree in unblocked frontier rounds

Grill SHALL maintain a per-issue design tree. Each round SHALL process every currently unblocked frontier node, record a recommendation and evidence for each, and SHALL NOT guess answers for nodes whose prerequisites are still open. A milestone-wide or batch-wide model response SHALL NOT be the authority for any one issue.

#### Scenario: Unblocked frontier is processed together

- **WHEN** an issue has two nodes whose prerequisites are settled and one node that depends on an open node
- **THEN** grill SHALL process the two unblocked nodes in that round
- **AND** SHALL leave the dependent node for a later round

#### Scenario: Batch prompt is not issue authority

- **WHEN** issues 10 and 11 are in the same frozen manifest
- **THEN** each issue’s Decisions artifact SHALL be produced from that issue’s facts and tree
- **AND** a single multi-issue model blob SHALL NOT be stored as either issue’s specification

---

### Requirement: Evidence-backed recommendations SHALL auto-settle inside existing authority

Grill SHALL automatically settle a recommendation when it is reversible, in scope, policy-consistent, and covered by existing authority. Provenance SHALL be `settled-by: auto-accept`. Low model confidence alone SHALL NOT pause the issue and SHALL NOT create a typed request. Auto-settle SHALL NOT grant merge, release, destructive, security, or other protected authority.

#### Scenario: In-scope default auto-settles

- **WHEN** a node has an evidence-backed recommendation that is reversible, in scope, policy-consistent, and covered by existing authority
- **THEN** grill SHALL record the node as resolved with `settled-by: auto-accept`
- **AND** SHALL NOT create a handoff for that node
- **AND** SHALL NOT wait for an operator round-trip

#### Scenario: Low confidence is not a human boundary

- **WHEN** the Implementer marks low confidence on a recommendation that still meets the auto-settle predicate
- **THEN** grill SHALL auto-settle that node
- **AND** SHALL NOT pause the issue for that reason alone

#### Scenario: Protected action is not auto-granted

- **WHEN** a recommendation would merge, release, destroy, or change a security-sensitive control and existing authority does not cover it
- **THEN** grill SHALL NOT auto-settle that node
- **AND** SHALL emit an `AuthorityRequest`

---

### Requirement: Only irreducible typed requests SHALL pause an issue

Grill SHALL pause an issue only for an irreducible `DecisionRequest` (contradictory product requirements), a `CapabilityRequest` that requires supplied input (missing external ability or information), or a protected `AuthorityRequest` (security-sensitive, irreversible, merge/release, or human-attested action without existing authority). Independent issues in the same batch SHALL continue. Typed requests SHALL reuse the existing human-question handoff ledger and `pipeline handoff answer`. Grill SHALL NOT add a second answer ledger or a new handoff CLI verb. Grill SHALL NOT create a handoff for every operator-required taxonomy class when auto-settle applies.

#### Scenario: Contradictory requirements become a DecisionRequest

- **WHEN** two acceptance criteria cannot both be true and the engine cannot infer a consistent recommendation
- **THEN** grill SHALL create a `DecisionRequest`
- **AND** SHALL NOT promote that issue to `pipeline:ready` while the request is unresolved
- **AND** SHALL continue independent issues in the batch

#### Scenario: Missing external input becomes a CapabilityRequest

- **WHEN** a node needs information or ability that is not in the repository, forge, configuration, or declared dependencies
- **THEN** grill SHALL create a `CapabilityRequest`
- **AND** SHALL pause only that issue

#### Scenario: Covered operator-required class does not auto-handoff

- **WHEN** a node is class `scope` and the recommendation is already covered by existing issue-body authority
- **THEN** grill SHALL auto-settle that node
- **AND** SHALL NOT create a grill-authority handoff for it

---

### Requirement: The GitHub issue body SHALL remain the executable specification

Grill SHALL write settled decisions into the issue body as the existing versioned Decisions artifact plus the derived `## Decisions` section with stable provenance. The issue body SHALL remain the specification. Comments and handoffs MAY prove provenance. They SHALL NOT replace the body. Divergence between the artifact and the rendered section SHALL fail ready validation.

#### Scenario: Apply-equivalent body write carries provenance

- **WHEN** grill auto-settles a node on issue 42
- **THEN** the live issue body SHALL contain the Decisions artifact recording that node as resolved with `settled-by: auto-accept`
- **AND** the readable `## Decisions` section SHALL equal the render of that artifact

#### Scenario: Comment is not the spec

- **WHEN** an issue comment states a decision that is absent from the body artifact
- **THEN** ready validation SHALL NOT treat that comment as a settled node

---

### Requirement: Domain-document writes SHALL use a dedicated worktree and PR

Newly settled project-specific vocabulary SHALL update `CONTEXT.md` using the repository glossary format. A qualifying hard-to-reverse trade-off SHALL create a concise ADR. Those writes SHALL use a dedicated worktree and pull request against the configured base. Grill SHALL NOT write the integration branch directly. Identical term or ADR payloads in one batch SHALL be deduplicated into one PR.

#### Scenario: CONTEXT term opens one docs PR

- **WHEN** two selected issues settle the same new glossary term
- **THEN** grill SHALL open one pull request that adds that term once
- **AND** SHALL NOT write `CONTEXT.md` on the integration branch

#### Scenario: Integration branch is untouched

- **WHEN** grill records a required CONTEXT change
- **THEN** no commit SHALL land on the configured integration branch as a direct push from grill

---

### Requirement: Required documentation SHALL block ready until trusted-base integration

A required domain-document change that is not yet on the trusted integration base SHALL leave that issue durably waiting. Advisory documentation SHALL NOT block admission. Resume after the documentation PR is contained in the trusted base SHALL re-check fingerprints against that fresh base. Grill SHALL NOT promote an issue from a stale base.

#### Scenario: Required CONTEXT waits

- **WHEN** the artifact records a required CONTEXT term missing from the current trusted-base blob
- **THEN** that issue SHALL remain waiting
- **AND** SHALL NOT receive `pipeline:ready`

#### Scenario: Advisory documentation does not block

- **WHEN** the artifact records only an advisory CONTEXT proposal
- **AND** all other ready checks pass
- **THEN** grill MAY promote the issue to `pipeline:ready`

#### Scenario: Stale base refuses promotion

- **WHEN** a required docs PR has merged but the recorded integration-base SHA is stale relative to the current trusted base
- **THEN** grill SHALL NOT promote the issue
- **AND** SHALL re-gather facts against the current trusted base on resume

---

### Requirement: Eligible issues SHALL be promoted to `pipeline:ready` inside the same operation

After the issue body, decision provenance, dependency facts, required domain terms, and current fingerprints all pass the existing model-free Decisions ready validator, grill SHALL add `pipeline:ready` first, remove other `pipeline:*` labels, re-fetch, and retry one remove pass if more than one `pipeline:*` remains. Persistent extras SHALL exit non-zero with `label_reconciliation_failed` and SHALL NOT remove `pipeline:ready`. Grill SHALL NOT invoke the #1238 issue-implementation-readiness model. The next pickup SHALL still run that gate against fresh GitHub state. Grill SHALL NOT merge or deploy.

#### Scenario: Eligible issue carries exactly one stage label

- **WHEN** ready validation passes for issue 42
- **AND** grill promotes it
- **THEN** issue 42 SHALL carry `pipeline:ready` as its only `pipeline:*` label
- **AND** no merge or deploy command SHALL have been invoked

#### Scenario: Incomplete artifact is not promoted

- **WHEN** an issue still has an unresolved typed request
- **THEN** grill SHALL NOT add `pipeline:ready`
- **AND** labels SHALL remain unchanged by the ready path

#### Scenario: Pickup still runs #1238

- **WHEN** grill has set `pipeline:ready` on issue 42
- **AND** a later pickup path runs with `issue_readiness.enabled` true
- **THEN** that pickup SHALL run the shared issue-implementation-readiness gate
- **AND** SHALL NOT start a worktree or delivery harness unless that gate admits the fresh body

---

### Requirement: Dry-run SHALL report without mutation

`--dry-run` SHALL resolve the frozen manifest and SHALL report inferred decisions, required typed requests, documentation actions, and ready eligibility for each selected issue. It SHALL NOT edit issues, labels, comments, handoffs, branches, or repository files.

#### Scenario: Dry-run writes nothing

- **WHEN** the operator runs `pipeline grill --milestone v1.40.1 --dry-run`
- **THEN** stdout SHALL include the frozen issue list and per-issue inferred actions
- **AND** no GitHub write SHALL occur
- **AND** no repository file SHALL be written

---

### Requirement: Grill SHALL be resumable with status and follow

A mutating grill invocation SHALL persist a durable run id, the frozen manifest, and per-issue state. `pipeline grill status --run-id <id>` SHALL print selected, migrated, waiting, ready, and failed counts plus per-issue evidence. `--follow` SHALL stream that run until a terminal batch status. `--resume <run-id>` SHALL continue the same frozen manifest. An irreducible typed request SHALL park only that issue and SHALL leave the run resumable.

#### Scenario: Status names waiting and ready counts

- **WHEN** a run has promoted issue 10 and parked issue 11 on a `DecisionRequest`
- **THEN** `pipeline grill status --run-id <id>` SHALL report ready count 1 and waiting count 1
- **AND** SHALL name issue 11 and the request type

#### Scenario: Resume continues after a docs wait

- **WHEN** issue 10 is waiting for a required docs PR
- **AND** that PR is later contained in the trusted base
- **AND** the operator runs `pipeline grill --resume <run-id>`
- **THEN** grill SHALL re-validate issue 10 against the fresh base
- **AND** SHALL NOT re-resolve selector membership

---

### Requirement: Existing #1316 and grill-with-docs markers SHALL migrate without duplicate mutations

Grill SHALL recognize `decisions.v1` artifacts, host-local grill frontiers, pending grill-authority handoffs, `grill-proposal.v1` envelopes, and `grill-with-docs:v1.40.1` review markers plus Decisions sections. It SHALL re-gather facts and SHALL reject stale recommendations rather than trusting a marker alone. Replay of a migrated issue SHALL NOT duplicate body edits, documentation PRs, handoffs, or label transitions. Compatibility `refine-spec --issue` / `apply` SHALL NOT remain a second permanent intake controller after replacement coverage passes.

#### Scenario: Stale marker is not trusted

- **WHEN** an open issue carries `<!-- grill-with-docs:v1.40.1 -->` and a recommendation whose facts have changed
- **THEN** grill SHALL reject that recommendation
- **AND** SHALL re-walk the design tree from current facts

#### Scenario: Replay is idempotent

- **WHEN** grill has already written the Decisions body and promoted issue 10
- **AND** the operator re-runs `pipeline grill --issue 10`
- **THEN** grill SHALL NOT write a second duplicate Decisions body
- **AND** SHALL NOT open a second docs PR for the same payload
- **AND** SHALL NOT create a duplicate handoff
- **AND** SHALL NOT flip labels away from `pipeline:ready` when ready validation still passes

---

### Requirement: Grill unit tests SHALL inject GitHub, repository, model, clock, and filesystem I/O

Unit tests for selector resolution, freeze, per-issue settlement, typed requests, docs-PR dedup, ready promotion, resume, and migration SHALL inject those I/O seams. No unit test SHALL perform a real network, git, or subprocess call. The suite SHALL cover one issue, an explicit list, a milestone, repeated-label intersection, selection drift, dependency ordering, auto-accept, each typed request, shared docs deduplication, resume, partial batch failure, stale inputs, and ready-label reconciliation.

#### Scenario: Injected suite covers the locked cases

- **WHEN** the grill-with-docs-admission unit suite runs
- **THEN** it SHALL exercise one issue, explicit list, milestone, label intersection, selection drift, dependency ordering, auto-accept, DecisionRequest, CapabilityRequest, AuthorityRequest, docs dedup, resume, partial failure, stale inputs, and ready-label reconciliation
- **AND** no test SHALL open a real GitHub, git, or subprocess call

---

### Requirement: First production `--milestone v1.40.1` SHALL emit a batch report

When `pipeline grill --milestone v1.40.1` runs to completion, grill SHALL migrate existing `grill-with-docs:v1.40.1` markers on every selected open issue, re-gather facts, auto-settle still-current recommendations, create only irreducible typed requests, land or wait for required domain documentation, and promote every eligible issue to `pipeline:ready`. The batch report SHALL prove selected, migrated, waiting, ready, and failed counts plus per-issue evidence.

#### Scenario: Milestone report includes the five counts

- **WHEN** `pipeline grill --milestone v1.40.1` finishes
- **THEN** the report SHALL include selected, migrated, waiting, ready, and failed counts
- **AND** SHALL include per-issue evidence for each selected issue
