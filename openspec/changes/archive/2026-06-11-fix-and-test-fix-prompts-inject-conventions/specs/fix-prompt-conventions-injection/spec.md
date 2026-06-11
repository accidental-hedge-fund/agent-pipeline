## ADDED Requirements

### Requirement: fix and test-fix prompts SHALL embed target-repo conventions

`buildFixPrompt` and `buildTestFixPrompt` SHALL pass `conventions: readConventions(cfg)` in their interpolation maps, and `fix.md` and `test_fix.md` SHALL each contain a `{{conventions}}` placeholder that renders the target repo's conventions content to the editing harness. The injection mechanism SHALL be identical to the one used by `buildImplementingPrompt` and `implementing.md`.

#### Scenario: fix prompt contains injected conventions

- **WHEN** `buildFixPrompt` is called with a config whose `conventions_md_path` resolves to a non-empty file
- **THEN** the returned prompt string SHALL contain the content read from that conventions file
- **AND** the prompt SHALL NOT require any host auto-load to deliver conventions to the editing harness

#### Scenario: test-fix prompt contains injected conventions

- **WHEN** `buildTestFixPrompt` is called with a config whose `conventions_md_path` resolves to a non-empty file
- **THEN** the returned prompt string SHALL contain the content read from that conventions file
- **AND** the prompt SHALL NOT require any host auto-load to deliver conventions to the editing harness

#### Scenario: absent conventions file renders the readConventions stub without error

- **WHEN** `buildFixPrompt` or `buildTestFixPrompt` is called and no conventions file exists at the resolved path
- **THEN** the `{{conventions}}` placeholder SHALL render the same `readConventions` stub that `buildImplementingPrompt` produces (the "no conventions file found" notice), not an unfilled placeholder
- **AND** the builder SHALL NOT throw or block prompt construction

### Requirement: fix and test-fix conventions injection has regression tests

The test suite SHALL include at least one test for `buildFixPrompt` and one for `buildTestFixPrompt` that assert the injected conventions content appears in the returned prompt string. Each test SHALL fail (bite) when the `conventions` key is absent from the builder's interpolation map.

#### Scenario: regression test bites without the fix

- **WHEN** the `conventions` key is removed from `buildFixPrompt`'s interpolation map
- **THEN** the corresponding unit test SHALL fail with a message indicating the conventions content is missing from the prompt

#### Scenario: regression test passes with the fix

- **WHEN** `buildFixPrompt` passes `conventions: readConventions(cfg)` in its interpolation map
- **THEN** the unit test SHALL pass with the injected content present in the returned prompt
