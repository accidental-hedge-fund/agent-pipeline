## ADDED Requirements

### Requirement: Evidence bundle SHALL surface candidate-integrity transitions

The durable run evidence trail (run ledger and, when a JSON evidence bundle is written, the bundle or its linked event stream) SHALL record `candidate_integrity` transitions produced by the candidate-integrity protocol. Recorded fields SHALL include before/after candidate SHAs, mutation method, classification, bounded changed-path summary, and review/readiness invalidation reason or flags when invalidation occurs. Evidence writes remain non-fatal to pipeline control flow under existing evidence-bundle rules, but the control-plane invalidation disposition itself is authoritative from the integrity protocol, not from optional bundle presence.

#### Scenario: Bundle or ledger includes a scope-expansion event

- **WHEN** a covered mutation classifies as `scope_expansion` during a run that records durable events
- **THEN** a `candidate_integrity` event with that classification and before/after SHAs SHALL appear in the durable event stream
- **AND** when an evidence bundle is finalized for that run, the transition SHALL be discoverable from the bundle or its linked events without requiring a separate human diary

#### Scenario: Missing optional bundle does not clear integrity invalidation

- **WHEN** candidate-integrity invalidates readiness for a head
- **AND** evidence-bundle write is skipped or fails non-fatally
- **THEN** the invalidation disposition SHALL still hold
- **AND** the run ledger event (when the ledger is available) remains the primary durable record for scoreboard consumers
