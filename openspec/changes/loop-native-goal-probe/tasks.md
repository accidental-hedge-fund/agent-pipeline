## 1. Pin the evidence

- [ ] 1.1 Record the reference-host observations in the code comment beside the floor table:
      `claude --version` → `2.1.216 (Claude Code)`, `claude --help | grep -i goal` → empty,
      native `/goal` run completed 2026-07-21; `codex --version` → `codex-cli 0.144.6`.
- [ ] 1.2 Confirm no other call site depends on `NATIVE_GOAL_MARKER` being authoritative
      (`grep -rn NATIVE_GOAL_MARKER core/`).

## 2. Configuration

- [ ] 2.1 Add the optional operator-attestation key to the loop config schema in
      `core/scripts/config.ts` (`auto` default | `available` | `unavailable`), with the
      matching defaults/merge entry and scaffold comment lines alongside the existing keys.
- [ ] 2.2 Add a config test asserting the key parses, defaults to automatic detection when
      absent, and rejects an unknown value.

## 3. Probe implementation

- [ ] 3.1 In `core/scripts/loop-preflight.ts`, add the per-engine floor table
      (`claude` → floor `2.1.216` + evidence; `codex` → no known native goal mode).
- [ ] 3.2 Add a tolerant version extractor/comparator (first `major.minor.patch`, numeric
      component-wise compare, fail-closed when no match).
- [ ] 3.3 Rewrite `checkNativeGoalCapability` to resolve attestation → `--help` positive
      marker → version floor, failing closed otherwise. Keep it read-only and driven entirely
      through `DoctorDeps`.
- [ ] 3.4 Build the failure remediation from the detected version, the required floor (or the
      "no known native goal mode" statement), and the attestation key + values.
- [ ] 3.5 Thread the attestation value into the call sites (`runLoopPreflight`, `pipeline
      doctor`, installer) without altering their check ordering or the selector-free
      `--audit` bypass (#451 delta `ac3bdbd2`).

## 4. Tests

- [ ] 4.1 Regression test for #506: `claude` help with no `goal` marker + `--version`
      `2.1.216 (Claude Code)` → `pass`. Confirm it fails against the pre-change probe.
- [ ] 4.2 True-negative tests: below-floor version, engine with no floor, exec failure, empty
      output, and unparseable version → `fail`.
- [ ] 4.3 Attestation tests: `available` overrides a failing detection; `unavailable`
      overrides a passing one.
- [ ] 4.4 Remediation-content assertions for the below-floor and no-known-floor cases.
- [ ] 4.5 Positive-marker test: `--help` advertising goal mode passes even below the floor.
- [ ] 4.6 Re-run the existing `runLoopPreflight` tests unchanged, including both
      `--audit` bypass tests and the contract-coherence short-circuit ordering test.

## 5. Docs, mirror, gate

- [ ] 5.1 Update the host SKILL/docs text describing the native-goal requirement to state the
      real detection contract and the attestation key.
- [ ] 5.2 Regenerate the mirror: `node scripts/build.mjs`; commit `plugin/` in the same change.
- [ ] 5.3 `npm run ci` green from the repo root.
- [ ] 5.4 End-to-end sanity on the reference host: `pipeline loop --milestone v1.22.0 --audit`
      and a selector run get past the native-goal gate.
