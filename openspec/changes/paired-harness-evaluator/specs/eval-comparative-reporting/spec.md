## MODIFIED Requirements

### Requirement: Comparative reports SHALL provide pair-aware treatment identity and convergence metrics

For a paired treatment, the comparative report SHALL expose requested primary and reviewer harness/model/effort coordinates and paired convergence observations alongside existing completion, quality, duration, cost, and baseline-delta fields. Missing cost or unavailable resolved model provenance SHALL remain explicitly unknown.

#### Scenario: Baseline comparison distinguishes pair direction

- **WHEN** a report compares Claude→Codex with Codex→Grok
- **THEN** the treatment identity SHALL preserve both harness roles and their order
- **AND** SHALL NOT collapse the two treatments into a single unordered harness set
