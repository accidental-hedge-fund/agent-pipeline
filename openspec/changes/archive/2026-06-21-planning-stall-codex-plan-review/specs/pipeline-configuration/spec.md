## ADDED Requirements

### Requirement: Config SHALL accept an optional plan_review_timeout key
`PartialConfigSchema` SHALL accept an optional positive-integer key `plan_review_timeout`
representing the wall-clock cap in seconds for the plan-review harness invocation.
`PipelineConfig` SHALL include `plan_review_timeout: number`. `DEFAULT_CONFIG` SHALL set
it to `300`. An absent key SHALL resolve to `300` seconds. A non-integer or non-positive
value SHALL cause `resolveConfig()` to throw with a parse error identifying the
offending field.

#### Scenario: plan_review_timeout absent — default 300 s applied
- **WHEN** `.github/pipeline.yml` does not set `plan_review_timeout`
- **THEN** `cfg.plan_review_timeout` SHALL equal 300

#### Scenario: File sets plan_review_timeout
- **WHEN** `.github/pipeline.yml` sets `plan_review_timeout: 600`
- **THEN** `cfg.plan_review_timeout` SHALL equal 600
- **AND** other timeout fields SHALL be unchanged

#### Scenario: Non-positive value rejected
- **WHEN** `.github/pipeline.yml` sets `plan_review_timeout: 0`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `plan_review_timeout`
  as the offending field

#### Scenario: Non-integer value rejected
- **WHEN** `.github/pipeline.yml` sets `plan_review_timeout: "fast"`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `plan_review_timeout`
  as the offending field
