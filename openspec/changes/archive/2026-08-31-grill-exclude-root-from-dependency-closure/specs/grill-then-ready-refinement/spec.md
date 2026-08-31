## MODIFIED Requirements

### Requirement: Facts and dependencies SHALL use the existing grammar and a bounded closure

Preview SHALL read repository facts from the trusted integration-base revision and the exact refinement context. Dependency extraction SHALL call `parseDeclaredDependencyIds` in `declared-dependency-grammar.ts`. Pipeline SHALL walk a versioned bounded dependency closure (max depth 8, max 32 issue ids). Preview, apply, and `pipeline triage --stage ready` SHALL call that same walker. Root declared-dependency edges SHALL be parsed from the proposed specification core at preview and sign time, and from the applied specification core after apply. Pipeline SHALL NOT parse root edges from the pre-proposal body when a proposed or applied specification exists. Pipeline SHALL NOT parse root edges from the Pipeline-owned Decisions fence, the rendered Decisions section, or handoff provenance. The dependency-closure record SHALL NOT include the root issue in `ids` or `per_id`. Cycles, inaccessible or missing issues, malformed declarations, and closure-limit exhaustion SHALL be typed unresolved facts with codes `dependency.cycle`, `dependency.missing`, `dependency.inaccessible`, `dependency.malformed`, and `dependency.closure_exhausted`. Any unresolved fact with one of those codes SHALL fail `--stage ready` with exit 2 and no label write. Pipeline SHALL NOT silently truncate the closure. Pipeline SHALL NOT invent a second dependency parser. Comments SHALL NOT become settled specification decisions.

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

#### Scenario: Proposed specification core supplies root edges before signing

- **WHEN** the Implementer proposed body adds, removes, or changes a declared dependency relative to the pre-proposal body
- **THEN** preview SHALL compute the dependency-closure fingerprint from that proposed specification core before it signs the envelope
- **AND** SHALL NOT sign a closure computed from the pre-proposal body

#### Scenario: Applied specification core supplies root edges at ready

- **WHEN** apply has written a Decisions body
- **AND** `pipeline triage N --stage ready` recomputes `dependency_closure_sha256`
- **THEN** ready SHALL parse root declared-dependency edges from the applied specification core
- **AND** SHALL NOT parse those edges from the Decisions fence, the rendered Decisions section, or handoff provenance

---

## ADDED Requirements

### Requirement: Pipeline-owned Decisions metadata SHALL NOT stale the dependency-closure fingerprint

Pipeline SHALL bind root issue identity only with `title_sha256` and `applied_body_sha256`. `dependency_closure_sha256` SHALL hash reachable declared-dependency issues only. It SHALL NOT hash the root title or the root body, full or core. Applying or materializing Pipeline-owned Decisions metadata, including the Decisions fence, the rendered Decisions section, and handoff provenance, SHALL NOT change `dependency_closure_sha256`. A later title or body change on a reachable declared dependency SHALL still stale `dependency_closure_sha256`. A root title change SHALL still stale `title_sha256`. A specification-core change SHALL still stale `applied_body_sha256`. Title, applied-body, integration-base, CONTEXT, provider, and planning-treatment fingerprints SHALL stay at current strength. `pipeline triage --stage ready` SHALL still compare those fingerprints. It SHALL NOT skip the ready fingerprint check. It SHALL NOT add a ready-only exception that leaves preview and ready on different root-body representations.

#### Scenario: Decisions metadata does not change the closure hash

- **WHEN** preview has signed a dependency-closure fingerprint from the proposed specification core
- **AND** apply writes the Decisions fence and rendered Decisions section
- **AND** every authority handoff is answered and provenance is recorded in the body
- **AND** no bound input changed and no declared dependency changed
- **THEN** `dependency_closure_sha256` SHALL equal the signed value
- **AND** `pipeline triage N --stage ready` SHALL succeed

#### Scenario: Root is absent from the closure record

- **WHEN** Pipeline walks the declared-dependency closure for issue N
- **THEN** the closure record `ids` and `per_id` SHALL NOT include N
- **AND** `dependency_closure_sha256` SHALL NOT hash the title or body of N

#### Scenario: Dependency title or body change still stales the closure

- **WHEN** a reachable declared-dependency issue title or body changes after preview
- **AND** the operator runs `pipeline triage N --stage ready`
- **THEN** the command SHALL exit 2
- **AND** the reason SHALL include `stale fingerprints: dependency_closure_sha256`
- **AND** labels SHALL be unchanged

#### Scenario: Root title change stales title fingerprint only

- **WHEN** the root issue title changes after preview
- **AND** the specification core and declared dependencies are unchanged
- **THEN** `--stage ready` SHALL report `title_sha256` as stale
- **AND** SHALL NOT treat that title change as a `dependency_closure_sha256` change

#### Scenario: Specification-core change stales applied-body fingerprint

- **WHEN** the applied specification core changes after preview
- **AND** declared dependencies are unchanged
- **THEN** `--stage ready` SHALL report `applied_body_sha256` as stale

#### Scenario: Preview apply and ready share one snapshot formula

- **WHEN** preview signs `dependency_closure_sha256`
- **AND** apply persists that fingerprint
- **AND** ready recomputes it
- **THEN** all three surfaces SHALL call the same walker
- **AND** all three SHALL use the proposed or applied specification core as the root edge source
- **AND** a representation split between original body, specification core, and full applied body SHALL NOT be able to stale the closure by itself

### Requirement: Pipeline SHALL refresh a root-inclusive signed closure without new authority answers

When `pipeline refine-spec --issue N` reads an applied Decisions artifact whose only stale fingerprint field is `dependency_closure_sha256`, Pipeline SHALL sign a root-exclusive `dependency_closure_sha256` from the current walker only when the recorded hash equals the legacy root-inclusive closure of an authenticated historical pre-proposal snapshot that was actually signed, together with the current declared-dependency snapshot. Pipeline SHALL obtain that snapshot from GitHub issue body revisions. Pipeline SHALL NOT treat the current applied specification core as that snapshot. If no such snapshot exists or none authenticates, preview SHALL use the normal refine-spec flow. That authenticated preview SHALL NOT call the Implementer or the Reviewer. It SHALL preserve existing nodes and settled handoff provenance. `pipeline refine-spec apply --issue N` SHALL persist that signed snapshot. Apply SHALL NOT create replacement authority handoffs for already-settled nodes. `pipeline triage --stage ready` SHALL still compare fingerprints. It SHALL NOT skip the ready fingerprint check. It SHALL NOT add a ready-only dual-formula comparison.

#### Scenario: Root-inclusive pre-change artifact recovers

- **WHEN** an applied artifact records a root-inclusive `dependency_closure_sha256`
- **AND** the signed root body is a historical pre-proposal snapshot that differs from the applied specification core
- **AND** no bound input changed
- **AND** every authority handoff is already answered
- **AND** the operator runs `pipeline refine-spec --issue N` then `pipeline refine-spec apply --issue N`
- **THEN** preview SHALL NOT call the Implementer or the Reviewer
- **AND** apply SHALL write a root-exclusive `dependency_closure_sha256`
- **AND** settled handoff provenance SHALL remain
- **AND** `pipeline triage N --stage ready` SHALL succeed

#### Scenario: Applied specification core is not the historical snapshot

- **WHEN** an applied artifact records a root-inclusive `dependency_closure_sha256` signed from the pre-proposal body
- **AND** that pre-proposal body differs from the applied specification core
- **AND** no authenticated historical pre-proposal snapshot is available
- **AND** the operator runs `pipeline refine-spec --issue N`
- **THEN** preview SHALL call the Implementer and the Reviewer
- **AND** SHALL NOT treat the current applied specification core as the signed historical snapshot

#### Scenario: Real declared-dependency change does not use the migration shortcut

- **WHEN** an applied artifact's only stale fingerprint field is `dependency_closure_sha256`
- **AND** the recorded hash is not the legacy root-inclusive closure of an authenticated historical snapshot and the current declared-dependency snapshot
- **AND** the operator runs `pipeline refine-spec --issue N`
- **THEN** preview SHALL call the Implementer and the Reviewer
- **AND** SHALL NOT sign the live exclusive closure onto the existing settled artifact without that review

### Requirement: Grill-then-ready tests SHALL replay Decisions self-stale and keep fail-closed dependency cases

Unit tests with injected GitHub and handoff I/O SHALL replay preview → apply → answer every authority handoff → `pipeline triage N --stage ready`. Those tests SHALL assert that the Decisions fence, rendered Decisions section, and handoff provenance do not change `dependency_closure_sha256`. They SHALL assert that a proposed body that adds, removes, or changes a declared dependency updates the closure before signing. They SHALL assert that a later dependency title or body change still stales `dependency_closure_sha256`. They SHALL assert that a reachable dependency title or body change does not take the root-inclusive preview refresh shortcut. They SHALL replay recovery of a root-inclusive pre-change artifact whose signed pre-proposal body differs from the applied specification core, through preview and apply without new Implementer, Reviewer, or authority answers. They SHALL assert that treating the applied specification core as the historical snapshot does not recover that artifact. Existing fail-closed tests for cycle, missing, inaccessible, malformed, depth exhaustion, and count exhaustion SHALL remain. No unit test SHALL perform a real network, git, or subprocess call.

#### Scenario: Injected sequence matches #1305 and #1344

- **WHEN** the grill-then-ready unit suite runs
- **THEN** it SHALL replay preview, apply, answer every authority handoff, and `triage --stage ready` with injected GitHub and handoff I/O
- **AND** that sequence SHALL succeed when no bound input changed and no declared dependency changed
- **AND** adding Decisions metadata SHALL leave `dependency_closure_sha256` unchanged
- **AND** no test SHALL open a real GitHub, git, or subprocess call

#### Scenario: Root-inclusive artifact recovery is tested

- **WHEN** the grill-then-ready unit suite runs
- **THEN** it SHALL replay an applied root-inclusive fingerprint whose signed pre-proposal body differs from the applied specification core
- **AND** that sequence SHALL not call Implementer or Reviewer
- **AND** it SHALL not require a new authority answer
- **AND** `triage --stage ready` SHALL succeed afterward
- **AND** a replay that offers only the applied specification core as the historical snapshot SHALL call Implementer and Reviewer

#### Scenario: Fail-closed dependency cases remain

- **WHEN** the grill-then-ready unit suite runs
- **THEN** it SHALL still cover cycle, missing, inaccessible, malformed, depth exhaustion, and count exhaustion
- **AND** those cases SHALL still fail `--stage ready` with exit 2 and no label write

### Requirement: Operator-facing grill fingerprint docs SHALL state the root and closure contract

Operator-facing grill or ready fingerprint documentation SHALL state that root identity is title plus applied specification core, that dependency closure covers declared dependencies only, and that Pipeline-owned Decisions metadata is not a bound input. Pipeline SHALL write that contract where grill or ready fingerprints are already described. Pipeline SHALL NOT add a new verb. Pipeline SHALL NOT add a new markdown file per command.

#### Scenario: Existing fingerprint docs carry the contract

- **WHEN** an operator reads the existing grill or ready fingerprint documentation
- **THEN** that documentation SHALL state the root identity binding, the dependency-only closure, and that Decisions metadata is not a bound input
- **AND** the change SHALL NOT add a new CLI verb
- **AND** the change SHALL NOT add a new markdown file per command
