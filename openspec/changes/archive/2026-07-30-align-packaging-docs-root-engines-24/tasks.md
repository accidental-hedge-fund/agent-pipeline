## 1. Package metadata alignment

- [x] 1.1 Set root `package.json` `engines.node` to `">=24"` (match `core/package.json`)
- [x] 1.2 Confirm root and core `version` fields are identical (fix only if already drifted)

## 2. Packaging coherence gate (CI)

- [x] 2.1 Add a deterministic scripts-level test (or small helper under `scripts/`) that asserts root `version` === core `version`
- [x] 2.2 Extend that gate to fail when root `engines.node` admits majors below the core floor (today: below 24)
- [x] 2.3 Prove the gate bites: temporarily diverge a fixture or document a forced-fail path in the test so a mismatch fails the assertion
- [x] 2.4 Ensure the gate runs under `npm run ci` (via existing `ci:scripts` / scripts test runner)

## 3. loop:contract-coherence optional absence

- [x] 3.1 Change `checkLoopContractCoherence` so undiscovered goal-loop returns `skip` (or `warn`), not `fail`
- [x] 3.2 Keep fail paths for unreadable discovered install and out-of-supported-set schema ids
- [x] 3.3 Update `loop-preflight.ts` module/header comments so they no longer claim loop run-start requires external goal-loop discovery
- [x] 3.4 Update doctor check description/comments for optional/legacy semantics if they still say “required”
- [x] 3.5 Update installer `checkLoopCoherence` messaging: remove “loop unavailable until goal-loop is installed”; keep incompatible-pairing hard fail
- [x] 3.6 Update installer comments that claim doctor hard-fails on missing goal-loop

## 4. README and doctor-table accuracy

- [x] 4.1 Replace recommended / worked-example install pins that use `#v1.2.1` with current release tag or unversioned + “pin a released tag” wording
- [x] 4.2 Replace remaining `v1.2.1` illustrations in “install a specific version” (and any clone/checkout examples) the same way
- [x] 4.3 Fix durable-loop / `pipeline:loop` prose that still implies external goal-loop is required
- [x] 4.4 Fix the README doctor-check table row for `loop:contract-coherence` so absence is non-failing and loop does not require goal-loop

## 5. Tests

- [x] 5.1 Update `core/test/loop-preflight.test.ts` (and any doctor tests) for absence → skip/warn, not fail
- [x] 5.2 Update `scripts/install.test.mjs` expectations for installer messaging and absence behavior
- [x] 5.3 Add/adjust regression coverage so a discovered incompatible goal-loop still fails doctor and installer
- [x] 5.4 Run core unit tests for touched modules

## 6. Verification

- [x] 6.1 Run `npm run ci` from repo root and fix any failures
- [x] 6.2 Manually confirm: root engines ≥24; no README `v1.2.1` recommended pins; doctor absence path non-failing in tests
- [x] 6.3 If any `core/` sources changed, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit as those core edits
