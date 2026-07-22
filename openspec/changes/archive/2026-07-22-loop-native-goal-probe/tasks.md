## 1. Pin the evidence

- [x] 1.1 Record the reference-host observations in the code comment beside the floor table:
      `claude --version` → `2.1.216 (Claude Code)`, `claude --help | grep -i goal` → empty,
      native `/goal` run completed 2026-07-21; `codex --version` → `codex-cli 0.144.6`.
- [x] 1.2 Confirm no other call site depends on `NATIVE_GOAL_MARKER` being authoritative
      (`grep -rn NATIVE_GOAL_MARKER core/`).

## 2. Configuration

- [x] 2.1 Add the optional operator-attestation key to the loop config schema in
      `core/scripts/config.ts` (`auto` default | `available` | `unavailable`), with the
      matching defaults/merge entry and scaffold comment lines alongside the existing keys.
- [x] 2.2 Add a config test asserting the key parses, defaults to automatic detection when
      absent, and rejects an unknown value.

## 3. Probe implementation

- [x] 3.1 In `core/scripts/loop-preflight.ts`, add the per-engine floor table
      (`claude` → floor `2.1.216` + evidence; `codex` → no known native goal mode).
- [x] 3.2 Add a tolerant version extractor/comparator (first `major.minor.patch`, numeric
      component-wise compare, fail-closed when no match).
- [x] 3.3 Rewrite `checkNativeGoalCapability` to resolve attestation → `--help` positive
      marker → version floor, failing closed otherwise. Keep it read-only and driven entirely
      through `DoctorDeps`.
- [x] 3.4 Build the failure remediation from the detected version, the required floor (or the
      "no known native goal mode" statement), and the attestation key + values.
- [x] 3.5 Thread the attestation value into the call sites (`runLoopPreflight`, `pipeline
      doctor`, installer) without altering their check ordering or the selector-free
      `--audit` bypass (#451 delta `ac3bdbd2`). (Neither `pipeline doctor` nor the installer
      call `checkNativeGoalCapability` today — only `runLoopPreflight` does — so the
      attestation is threaded through that one real call site, read gh-free from
      `.github/pipeline.yml` via `resolveLoopNativeGoalAttestation`.)

## 4. Tests

- [x] 4.1 Regression test for #506: `claude` help with no `goal` marker + `--version`
      `2.1.216 (Claude Code)` → `pass`. Confirm it fails against the pre-change probe.
- [x] 4.2 True-negative tests: below-floor version, engine with no floor, exec failure, empty
      output, and unparseable version → `fail`.
- [x] 4.3 Attestation tests: `available` overrides a failing detection; `unavailable`
      overrides a passing one.
- [x] 4.4 Remediation-content assertions for the below-floor and no-known-floor cases.
- [x] 4.5 Positive-marker test: `--help` advertising goal mode passes even below the floor.
- [x] 4.6 Re-run the existing `runLoopPreflight` tests unchanged, including both
      `--audit` bypass tests and the contract-coherence short-circuit ordering test.

## 5. Docs, mirror, gate

- [x] 5.1 Update the host SKILL/docs text describing the native-goal requirement to state the
      real detection contract and the attestation key.
- [x] 5.2 Regenerate the mirror: `node scripts/build.mjs`; commit `plugin/` in the same change.
- [x] 5.3 `npm run ci` green from the repo root.
- [x] 5.4 End-to-end sanity on the reference host: `pipeline loop --milestone v1.22.0 --audit`
      and a selector run get past the native-goal gate. (Verified directly against this host's
      claude 2.1.216: `pipeline loop --milestone v1.22.0 --profile claude` and
      `pipeline loop --audit --profile claude` both exit 0 past the native-goal gate.)
