## ADDED Requirements

### Requirement: Scripts unit tests run without multi-file test-runner IPC deserialize failures

The scripts unit-test entry point SHALL invoke Node's test runner such that a green
`scripts/*.test.mjs` suite does not fail CI with the Node test-runner infrastructure error
`Unable to deserialize cloned data due to invalid or unsupported version` originating from
`node:internal/test_runner/runner`. This applies to `ci:scripts` and to the scripts half of
`npm test` when it runs the same suite. The invocation SHALL use a structural isolation
approach: one top-level `node --test --test-isolation=none <file>` process per test file
(cross-file isolation via separate top-level processes; no process-isolation IPC within
each file) or an equivalent runner configuration proven to avoid that IPC decode path —
rather than time-based sleep retries as the primary mitigation.

#### Scenario: Full scripts suite completes without runner deserialize error

- **WHEN** `npm run ci:scripts` runs against the repository's current `scripts/*.test.mjs`
  files on the CI Node major version used by `.github/workflows/ci.yml`
- **AND** no product assertion in those files fails
- **THEN** the step SHALL exit 0
- **AND** SHALL NOT fail with `Unable to deserialize cloned data due to invalid or unsupported version` from the test runner host

#### Scenario: Structural invocation, not sleep-retry, is the primary mitigation

- **WHEN** the `ci:scripts` implementation is inspected
- **THEN** it SHALL implement one top-level process per test file with
  `--test-isolation=none` on each invocation (or an equivalent structural runner
  configuration) that avoids both the multi-file parent IPC deserialize path and the
  default process-isolation IPC path for large single files
- **AND** SHALL NOT rely on a fixed sleep or blind whole-suite retry loop as the sole
  mitigation for that deserialize failure class

### Requirement: Scripts test coverage remains in the full CI gate

`npm run ci` SHALL continue to execute the full scripts unit-test surface under
`scripts/*.test.mjs` (including `scripts/install.test.mjs`) as part of the gate. Removing
or skipping the scripts suite to avoid the flake is NOT permitted.

#### Scenario: ci script still runs scripts unit tests

- **WHEN** the root `package.json` `ci` script is inspected
- **THEN** it SHALL invoke `ci:scripts` (or an equivalent entry point that runs all
  `scripts/*.test.mjs` unit tests)
- **AND** SHALL NOT omit the scripts unit-test step from the `ci` chain

#### Scenario: install.test.mjs remains in the scripts suite

- **WHEN** `ci:scripts` runs
- **THEN** `scripts/install.test.mjs` SHALL be executed as part of that step
- **AND** a failing assertion inside `scripts/install.test.mjs` SHALL cause `ci:scripts` to
  exit non-zero

### Requirement: Product assertion failures remain visible and decisive

`ci:scripts` SHALL exit non-zero when a scripts unit test fails for product reasons and
SHALL surface the normal Node test-runner assertion / test failure output for the failing
test. Infrastructure isolation SHALL NOT swallow or rewrite product failures into success.

#### Scenario: Failing install assertion fails the scripts step

- **WHEN** a test in `scripts/install.test.mjs` fails an assertion
- **AND** `ci:scripts` runs
- **THEN** the step SHALL exit non-zero
- **AND** the output SHALL identify the failing test (name and assertion diagnostic) rather
  than only a test-runner IPC deserialize host error

### Requirement: Regression guard on the scripts-test runner invocation

The repository SHALL include an automated check that fails if the scripts-test entry point
is restored to the abandoned flake-prone multi-file runner invocation (the prior
`node --test scripts/*.test.mjs` single-parent aggregation form, or whatever prior form
implementation identifies as the load-bearing flake path), unless that form is re-validated
and the regression intentionally updated with a documented reason.

#### Scenario: Restoring the abandoned multi-file invocation fails the guard

- **WHEN** a regression test inspects the wired `ci:scripts` command (and shared wrapper, if
  any)
- **AND** that command is changed back to the abandoned single-parent multi-file form
  `node --test scripts/*.test.mjs` without an intentional, documented guard update
- **THEN** the regression test SHALL fail

#### Scenario: Chosen structural invocation remains wired from package.json

- **WHEN** the regression test inspects root `package.json`
- **THEN** it SHALL assert that `ci:scripts` points at the structural isolation entry point
  chosen by this change (wrapper script and/or explicit isolation flags)
- **AND** the test SHALL fail if `ci:scripts` is removed or redirected to a no-op
