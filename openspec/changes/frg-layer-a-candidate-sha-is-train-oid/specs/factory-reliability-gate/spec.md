## ADDED Requirements

### Requirement: From-run hybrid-v2 collect SHALL stamp the request packed candidate, not control HEAD

Hybrid-v2 collect for `pipeline factory-gate --from-run` (and the in-process equivalent) SHALL set `pack_provenance.candidate_git_sha` to the factory-release request `integrated_candidate.git_sha` (the train packed candidate, also recorded on the scored loop as `factory-release-binding.json` `candidate_git_sha`) when that request-bound identity is present. It SHALL NOT set that field from `git rev-parse HEAD` of the factory control checkout `repoDir` when control HEAD differs from that packed candidate. A missing request binding on a request-bound ship-path score SHALL fail closed. It SHALL NOT fall back to control HEAD. Fast-forwarding the control checkout SHALL NOT be required for collect to stamp the packed candidate. Skipping HMAC SHALL NOT be the path.

#### Scenario: Control checkout behind the train stamps the request candidate

- **WHEN** factory-release request `integrated_candidate.git_sha` is packed candidate `C`
- **AND** the factory control checkout HEAD is pin `P`
- **AND** `P` is not `C`
- **AND** `factory-gate --from-run` collects hybrid-v2 provenance
- **THEN** `pack_provenance.candidate_git_sha` SHALL equal `C`
- **AND** it SHALL NOT equal `P`

#### Scenario: Missing ship-path binding does not stamp control HEAD

- **WHEN** a request-bound ship-path `--from-run` score has no factory-release loop binding packed-candidate SHA
- **THEN** collect SHALL fail closed
- **AND** it SHALL NOT write `pack_provenance.candidate_git_sha` from control-checkout HEAD

#### Scenario: Collect regression fails when provenance stamps the pin

- **WHEN** a unit test provides `repoDir` HEAD pin `P` and request packed candidate `C`
- **AND** collected provenance sets `pack_provenance.candidate_git_sha` to `P`
- **THEN** that test SHALL fail

### Requirement: Layer A probe records SHALL use the same packed-candidate OID as pack provenance

Every Layer A probe record produced by from-run hybrid-v2 collect SHALL set `candidate_git_sha` to the same packed-candidate OID as `pack_provenance.candidate_git_sha`. Layer A probes for that score SHALL execute against candidate engine sources for that OID. They SHALL NOT treat factory control checkout HEAD as the candidate identity when it differs. Collect SHALL fail closed rather than bind TAP output from pin sources to the packed candidate.

#### Scenario: Probe records match pack provenance

- **WHEN** hybrid-v2 collect stamps `pack_provenance.candidate_git_sha` `C`
- **THEN** every Layer A probe record `candidate_git_sha` SHALL equal `C`

#### Scenario: Probes run on candidate engine sources for C

- **WHEN** control checkout HEAD is pin `P`
- **AND** packed candidate is `C`
- **AND** `P` is not `C`
- **AND** from-run collect runs Layer A probes
- **THEN** those probes SHALL execute against engine sources for `C`
- **AND** collect SHALL NOT hash pin-source TAP output and label it `C`
