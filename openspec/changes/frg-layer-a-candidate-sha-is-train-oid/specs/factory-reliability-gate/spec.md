## ADDED Requirements

### Requirement: From-run hybrid-v2 collect SHALL stamp the request packed candidate, not control HEAD

Hybrid-v2 collect for `pipeline factory-gate --from-run` (and the in-process equivalent) SHALL set `pack_provenance.candidate_git_sha` to one packed-candidate OID `C` resolved from named sources, not from `git rev-parse HEAD` of the factory control checkout `repoDir`. The named sources SHALL be (1) scored-loop `factory-release-binding.json` `candidate_git_sha` when that file is present and (2) factory-release request `integrated_candidate.git_sha` when the in-process scorer holds the request. Collect SHALL normalize each value to an exact 40-hex OID. When both values are in hand, collect SHALL require equality. A request-bound ship-path score (request SHA provided, or binding file present) SHALL fail closed before Layer A probes or evidence write when the binding file is missing, a present source is malformed, or the two parsed OIDs conflict. A present malformed source SHALL NOT fall back to the other source or to control HEAD. CLI `--from-run` without a request object SHALL use a present valid loop binding as `C`. Standalone `--from-run` (no request object and no binding file) MAY keep `git rev-parse HEAD` of `repoDir`. Request-bound ship-path collect SHALL NOT call `git rev-parse HEAD` of `repoDir` for identity. Fast-forwarding the control checkout SHALL NOT be required for collect to stamp the packed candidate. Skipping HMAC SHALL NOT be the path.

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

#### Scenario: Binding and request agree on packed candidate C

- **WHEN** loop `factory-release-binding.json` `candidate_git_sha` is packed candidate `C`
- **AND** in-process request `integrated_candidate.git_sha` is packed candidate `C`
- **AND** control checkout HEAD is pin `P` that is not `C`
- **THEN** collect SHALL set `pack_provenance.candidate_git_sha` to `C`
- **AND** it SHALL NOT call `git rev-parse HEAD` of `repoDir` for identity

#### Scenario: Conflicting request and binding fail closed

- **WHEN** loop binding `candidate_git_sha` is packed candidate `C`
- **AND** request `integrated_candidate.git_sha` is a different exact 40-hex OID
- **THEN** collect SHALL fail closed before Layer A probes
- **AND** it SHALL NOT write `pack_provenance.candidate_git_sha`

#### Scenario: Present malformed binding does not fall back

- **WHEN** the loop binding file is present
- **AND** `candidate_git_sha` is missing or is not an exact 40-hex OID
- **THEN** collect SHALL fail closed
- **AND** it SHALL NOT use request `integrated_candidate.git_sha` as a fallback from that present invalid binding
- **AND** it SHALL NOT use control-checkout HEAD

#### Scenario: Standalone from-run without binding keeps repoDir HEAD

- **WHEN** `factory-gate --from-run` has no factory-release request object
- **AND** the scored loop has no `factory-release-binding.json`
- **THEN** collect MAY set `pack_provenance.candidate_git_sha` from `git rev-parse HEAD` of `repoDir`

### Requirement: Layer A probe records SHALL use the same packed-candidate OID as pack provenance

Every Layer A probe record produced by from-run hybrid-v2 collect SHALL set `candidate_git_sha` to the same packed-candidate OID as `pack_provenance.candidate_git_sha`. Layer A probes for that score SHALL execute against candidate engine sources for that OID. Collect SHALL resolve those sources with the existing candidate-engine resolver at packed candidate `C` and SHALL pass the resolved engine root as the probe working directory. They SHALL NOT treat factory control checkout HEAD as the candidate identity when it differs. Collect SHALL fail closed when it cannot resolve a clean checkout whose HEAD is `C`. Collect SHALL fail closed rather than bind TAP output from pin sources to the packed candidate.

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
