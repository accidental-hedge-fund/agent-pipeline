## ADDED Requirements

### Requirement: No-change retry evidence SHALL remain bound to the observable pull request candidate

When a successful test-fix retry changes no candidate content, the Tester producer SHALL persist passed implementation-role evidence for the preserved candidate. Before that proof authorizes continuation, the pipeline SHALL freshly observe the current pull request head and require it to equal the evidence candidate. The pipeline SHALL NOT attest a divergent unpublished local head or weaken the existing pull-request-head rebinding verifier to accept one.

#### Scenario: Preserved candidate receives matching Tester proof

- **WHEN** a clean no-change retry passes on candidate `C`
- **AND** the authoritative pull request observer reports current head `C`
- **THEN** persisted passed implementation-role Tester evidence SHALL name candidate `C`
- **AND** exact-candidate rebinding SHALL succeed without a new candidate commit

#### Scenario: Unpublished local head is rejected

- **WHEN** Tester evidence names local head `L`
- **AND** the freshly observed pull request head remains `C` where `L` differs from `C`
- **THEN** the pipeline SHALL reject the evidence as not SHA-matched to the pull request candidate
- **AND** SHALL NOT treat an empty diff between `L` and `C` as authority to rebind the evidence

#### Scenario: Replacement pull request requires valid rebinding

- **WHEN** the issue resolves to a replacement pull request or a different pull request head after the retry
- **THEN** evidence for the prior pull request identity or head SHALL NOT authorize the replacement candidate
- **AND** the existing replacement and exact-head rebinding checks SHALL be satisfied before continuation

#### Scenario: Stale or unrelated evidence is rejected

- **WHEN** available Tester evidence names a stale or unrelated candidate rather than the freshly observed pull request head
- **THEN** the pipeline SHALL reject that evidence
- **AND** SHALL require valid exact-candidate proof under the existing producer and verifier identities

#### Scenario: Unobservable remote candidate fails closed

- **WHEN** the authoritative pull request head cannot be freshly observed
- **THEN** the pipeline SHALL NOT infer candidate identity from the local worktree or Tester artifact alone
- **AND** SHALL fail closed under the existing trusted-surface rebinding protections
