## ADDED Requirements

### Requirement: Unique-operation covered lifecycle classes SHALL come from executed matrix rows

Unique-operation evidence SHALL populate `covered_lifecycle_classes` from executed universal-fault-recovery-matrix rows bound to the scored candidate. Passing unique-operation helper fixtures SHALL NOT declare a required lifecycle class covered unless the matrix inventory reports that class covered. A declared class without a matrix row SHALL increment missing required coverage. This capability SHALL NOT invent a second coverage aggregator.

#### Scenario: Helper that stamps all five classes without rows fails coverage

- **WHEN** a passing unique-operation helper lists `mechanical`, `workflow`, `infrastructure`, `authentication`, and `unknown` as covered
- **AND** the matrix inventory reports none of those classes covered for the scored candidate
- **THEN** `missing_required_coverage` SHALL be greater than zero
- **AND** unique-operation SLO validation SHALL fail

#### Scenario: Matrix row covers only the classes it proved

- **WHEN** executed matrix rows cover `mechanical` and `unknown` only
- **THEN** `covered_lifecycle_classes` SHALL contain `mechanical` and `unknown`
- **AND** SHALL NOT contain `workflow`, `infrastructure`, or `authentication` unless other rows proved them
