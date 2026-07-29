## Why

GitHub Actions intermittently fails the scripts unit-test step (`npm run ci:scripts` →
`node --test scripts/*.test.mjs`) with a **Node test-runner infrastructure** error
(`Unable to deserialize cloned data due to invalid or unsupported version` in
`node:internal/test_runner/runner`), not an install assertion failure. That flake turns
pre-merge red on archive-only commits after product CI was green (dogfood #554 / PR #678,
run `30476223443`). Combined with the pre-merge hard CI gate (#181), an infra flake becomes
a human gate. This change stops **producing** that flake; separate work tracks pre-merge
recovery for infra flakes.

## What Changes

- Make the `ci:scripts` (and root `npm test` scripts-test) invocation run Node's test
  runner in a mode that **avoids the failing IPC / clone path** that surfaces the
  deserialize error — prefer a structural fix (process isolation, sequential file
  execution, suite split, or equivalent runner configuration) over sleep-based retries.
- Ensure failures from `scripts/install.test.mjs` (and the rest of `scripts/*.test.mjs`)
  surface as **product assertion failures** (or clear process exits from the tests
  themselves), not as unparsed test-runner host errors, when the suite is green on content.
- Document root-cause in the PR description (worker isolation vs large multi-file suite
  spawn vs parent/child version skew) based on isolation/reproduction work during
  implementation.
- Add a regression guard that would have failed under the old multi-file IPC-prone setup
  if a structural alternative is adopted (e.g. assert isolation flags / invocation shape),
  or otherwise prove the chosen runner configuration is load-bearing.
- **Out of scope:** changing pre-merge CI-gate recovery, auto-retry of whole GitHub Actions
  jobs, relaxing `test_gate` / `npm run ci` rigor, or rewriting install product tests for
  coverage reasons unrelated to runner flake.

## Capabilities

### New Capabilities

- `ci-scripts-test-reliability`: How this repo's scripts unit-test step (`ci:scripts` /
  `scripts/*.test.mjs` under Node's test runner) is invoked so CI does not fail on
  test-runner IPC deserialize infrastructure errors, while still running the full scripts
  test surface and reporting real assertion failures.

### Modified Capabilities

- _(none)_ — living `test-gate-ci-parity` still requires `npm run ci` as the full gate;
  this change only constrains how the scripts-test sub-step is run, not which steps
  compose the gate. Pre-merge recovery for infra flakes remains a separate track
  (`pre-merge-ci-gate` / post-#181).

## Acceptance Criteria

- [ ] PR description includes a short root-cause note explaining why the deserialize
      failure occurred (or the best-supported isolation hypothesis if full reproduction is
      not available) and why the chosen fix removes or greatly reduces that path.
- [ ] After the change, `npm run ci:scripts` (as wired by root `package.json`) does not
      fail with `Unable to deserialize cloned data due to invalid or unsupported version`
      from `node:internal/test_runner/runner` under the same multi-file scripts suite that
      previously flaked in CI.
- [ ] `scripts/install.test.mjs` and the other `scripts/*.test.mjs` files still run as
      part of `npm run ci` / `ci:scripts`; product assertion failures still fail the step.
- [ ] A regression check exists that would fail if the flake-prone runner invocation were
      restored (e.g. package.json / wrapper asserts isolation mode or sequential file
      process shape), or implementation records why an equivalent structural guard is
      impossible and substitutes the strongest available check.
- [ ] `npm run ci` is green on the change branch (including `ci:scripts` and
      `openspec validate --all`).
- [ ] Scope stays on **stop producing the flake**; no pre-merge recovery redesign and no
      demotion of review / CI rigor.

## Impact

- Root `package.json` scripts: likely `ci:scripts` and possibly the scripts half of
  `npm test` (both currently use `node --test scripts/*.test.mjs`).
- Possibly a small runner wrapper under `scripts/` if isolation/split cannot be expressed
  cleanly as npm script flags alone.
- Possibly light reorganization of how `scripts/*.test.mjs` files are listed or spawned
  (not product logic in `install.mjs` itself unless required for isolation).
- Tests that assert the `ci` / `ci:scripts` invocation shape (if any exist, or new ones
  under `scripts/`).
- No core engine stage changes, no `plugin/` mirror impact expected unless a core test
  mirror is added (unlikely for this change).
- Cross-link only: pre-merge recovery for remaining infra flakes stays out of band.
