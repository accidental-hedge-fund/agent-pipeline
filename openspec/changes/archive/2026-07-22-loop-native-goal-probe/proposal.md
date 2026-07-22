## Why

`checkNativeGoalCapability` (`core/scripts/loop-preflight.ts`) decides whether the active
engine has a built-in autonomous `/goal` mode by grepping `<bin> --help` for
`NATIVE_GOAL_MARKER` (`/goal` or `goal mode`). On Claude Code, `/goal` is an **interactive
slash command**: it is not a CLI flag and appears nowhere in `claude --help`. Verified on
claude 2.1.216 (2026-07-22): `claude --help | grep -i goal` returns nothing, while a native
six-milestone `/goal` run completed on the same host the previous day.

The probe therefore returns a false negative on every real Claude host. `pipeline loop
--milestone v1.22.0` aborts at preflight with *"claude's built-in /goal autonomous mode was
not detected"* and the misleading remediation *"update claude"* — even with goal-loop v0.2.0
installed and `loop:contract-coherence` passing. The v1.21.0 headline feature (#451) cannot
start a run anywhere, including the v1.22.0 run itself.

## What Changes

- Replace the `--help` string grep as the **authoritative** capability signal with a probe
  built on signals that actually carry slash-command availability:
  - a documented per-engine **version floor** compared against `<bin> --version`, with the
    floor's evidence (engine, version, date verified) recorded in the code and in `design.md`;
  - an explicit **operator attestation** config key so a host can assert or deny the
    capability when automated detection cannot decide;
  - the existing `--help` marker retained only as an additive *accepting* signal (if a future
    CLI does advertise goal mode, that still passes) — never as grounds for a negative.
- Make the failure path **accurate**: when the probe genuinely cannot confirm the capability,
  the remediation SHALL name the detected engine version, the required floor, and the
  attestation key — not a bare "update claude".
- Keep the gate **fail-closed**: an engine with no known native goal mode, an unparseable
  version, or an explicit `unavailable` attestation still refuses to start and performs no
  mutation.
- Leave the selector-free `--audit` bypass of the native-goal gate (#451 delta `ac3bdbd2`)
  exactly as shipped.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `pipeline-loop-facade`: the requirement "`pipeline:loop` SHALL require the host's built-in
  autonomous `/goal` mode" gains a precise, falsifiable detection contract (signal precedence,
  attestation override, fail-closed behavior, remediation content) in place of an
  unspecified capability probe that is satisfied today by a `--help` grep.

## Impact

- `core/scripts/loop-preflight.ts` — `checkNativeGoalCapability`, `NATIVE_GOAL_MARKER`.
- `core/scripts/config.ts` — one new optional config key for the operator attestation.
- `core/test/loop-preflight.test.ts` — regression coverage over the `DoctorDeps` seam.
- `core/scripts/stages/doctor.ts` — no seam change (`exec` already returns `stdout`/`ok`).
- `plugin/` mirror regenerated (`node scripts/build.mjs`); docs/SKILL text where the
  native-goal requirement is described.

## Acceptance criteria

- [ ] On a host running claude 2.1.216 whose `--help` contains no `goal` marker, the
      native-goal probe returns `pass` and `pipeline loop --milestone <m>` proceeds past
      preflight.
- [ ] The probe never treats absence of a `/goal` string in `--help` as evidence of absence;
      removing the marker from fixture help output does not flip a passing host to failing.
- [ ] A host whose engine version is below the documented floor, with no attestation, fails
      closed: exit non-zero, no lock, no ledger write, no GitHub mutation.
- [ ] The failure remediation names the detected version, the required floor, and the
      operator attestation config key.
- [ ] An operator attestation of `unavailable` fails closed even on an engine above the
      floor; an attestation of `available` passes even when version detection fails.
- [ ] The documented version floor carries in-code evidence (engine, version, date verified)
      explaining why that value was chosen.
- [ ] `core/test/loop-preflight.test.ts` covers, via the `DoctorDeps` seam with no real
      subprocess: the #506 false-negative case, the true-negative case, both attestation
      directions, and unparseable-version fail-closed.
- [ ] `runLoopPreflight` behavior for selector-free `--audit` is unchanged (its existing
      #451 delta `ac3bdbd2` tests still pass untouched).
- [ ] `npm run ci` passes from the repo root with the `plugin/` mirror in sync.
