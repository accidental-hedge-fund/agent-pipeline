## ADDED Requirements

### Requirement: Outer-host lifecycle evidence SHALL not collapse host identity into stage adapter identity

When outer-host lifecycle supervision records identity in run evidence, the pipeline SHALL keep
outer-host identity independent of stage adapter identity as already required by the adapter
extension registry identity-separation rules. Outer-host lifecycle registration and evidence
SHALL NOT require stage adapter registration for the same id, and stage adapter registration
SHALL NOT imply outer-host lifecycle capabilities.

#### Scenario: Host lifecycle and adapter extension remain separate registries

- **WHEN** a stage adapter id `my-ext` is registered without a matching outer-host id
- **THEN** the outer-host registry SHALL NOT invent an outer host named `my-ext`
- **AND** outer-host lifecycle capabilities SHALL NOT be inferred from that adapter's model or
  role declarations

#### Scenario: Evidence fields stay distinct under extension adapters

- **WHEN** a run uses outer host `claude` with implementer adapter `my-ext`
- **THEN** evidence SHALL record outer-host identity separately from implementer treatment
  identity `my-ext`
- **AND** neither field SHALL be rewritten to equal the other
