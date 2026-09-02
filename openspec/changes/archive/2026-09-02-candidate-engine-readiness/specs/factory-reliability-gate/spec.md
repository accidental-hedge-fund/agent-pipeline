## MODIFIED Requirements

### Requirement: Layer A probe records SHALL use the same packed-candidate OID as pack provenance

Every Layer A probe record produced by from-run hybrid-v2 collect SHALL set `candidate_git_sha` to the same packed-candidate OID as `pack_provenance.candidate_git_sha`. Layer A probes for that score SHALL execute against candidate engine sources for that OID. Collect SHALL resolve and prepare those sources with the shared resolve-and-prepare seam at packed candidate `C` and SHALL pass the prepared engine root as the probe working directory. Identity-only resolution SHALL NOT authorize TAP. They SHALL NOT treat factory control checkout HEAD as the candidate identity when it differs. Collect SHALL fail closed when it cannot resolve a clean checkout whose HEAD is `C`. Collect SHALL fail closed when resolve-and-prepare cannot prove candidate readiness. Collect SHALL fail closed rather than bind TAP output from pin sources to the packed candidate.

#### Scenario: Probe records match pack provenance

- **WHEN** hybrid-v2 collect stamps `pack_provenance.candidate_git_sha` `C`
- **THEN** every Layer A probe record `candidate_git_sha` SHALL equal `C`

#### Scenario: Probes run on candidate engine sources for C

- **WHEN** control checkout HEAD is pin `P`
- **AND** packed candidate is `C`
- **AND** `P` is not `C`
- **AND** from-run collect runs Layer A probes
- **THEN** those probes SHALL execute against engine sources for `C`
- **AND** the probe working directory SHALL be the resolved candidate engine root for `C`
- **AND** that directory SHALL NOT be the control checkout `repoDir` when `repoDir` HEAD is `P`
- **AND** collect SHALL NOT hash pin-source TAP output and label it `C`

#### Scenario: Unresolved candidate engine for C fails closed

- **WHEN** packed candidate is `C`
- **AND** collect cannot resolve a clean candidate engine checkout whose HEAD is `C`
- **THEN** collect SHALL fail closed before Layer A TAP
- **AND** it SHALL NOT write provenance that binds pin-source TAP to `C`

#### Scenario: Unready candidate engine for C fails closed before TAP

- **WHEN** packed candidate is `C`
- **AND** collect resolves a clean candidate engine checkout whose HEAD is `C`
- **AND** resolve-and-prepare cannot prove candidate readiness
- **THEN** collect SHALL fail closed before Layer A TAP
- **AND** it SHALL NOT write provenance that binds pin-source TAP to `C`
- **AND** no Layer A probe SHALL have executed
