## Why

After Tugboat restored the Factory Reliability Gate (FRG) ship path
(#1039), a production pin with `frg_run_id: "no-frg-X.Y.Z"` and
`frg_evidence_path: null` is no longer a valid success outcome. Thin-ship
promote still treats that marker as a successful production pin. That hides
a ship that never recorded a real FRG pass.

## What Changes

- Default `pipeline factory-pin promote` and `pipeline engine-promote`
  (non-skip) SHALL require a real FRG `run_id` and a non-null evidence
  path for the target version. They SHALL refuse `no-frg-*` and null
  evidence as the production-quality success path.
- The `--skip-frg` escape (or the shared resolved skip) MAY still write a
  pin that is clearly marked non-production-quality (`no-frg-<version>`
  plus null evidence). Default promote fails closed.
- `pipeline doctor` `install:engine-track` SHALL fail closed when the live
  production pin on this factory repo is `no-frg-*` (or has null evidence)
  under pinned intent.
- Same-version "already pinned" SHALL NOT count as success when that pin
  is a `no-frg-*` / null-evidence marker, unless the explicit skip is
  active.

**BREAKING** for operators who still treat a `no-frg-*` pin as a
successful production promote. Default promote and factory doctor now
fail until a real FRG pin exists.

## Acceptance Criteria

- [ ] Default `pipeline factory-pin promote --for X.Y.Z` and
      `pipeline engine-promote --for X.Y.Z` without resolved skip refuse
      to write or accept a production-quality pin when FRG evidence is
      missing, `pass: false`, unparsable, has a `no-frg-*` `run_id`, or
      would leave `frg_evidence_path` null. The existing pin is unchanged.
- [ ] A successful non-skip promote of `X.Y.Z` writes
      `frg_run_id` equal to the FRG evidence `run_id` (not `no-frg-*`)
      and a non-null `frg_evidence_path` for that version.
- [ ] Explicit `--skip-frg` (or the shared resolved skip) still writes a
      pin whose `frg_run_id` is `no-frg-X.Y.Z` and whose
      `frg_evidence_path` is null. The pin is visibly not
      production-quality. Default promote does not take this path.
- [ ] When the live pin is already at `X.Y.Z` but is `no-frg-*` / null
      evidence, default engine-promote SHALL NOT treat that pin as
      already-current success. It SHALL refuse or re-promote from a real
      FRG pass.
- [ ] On this factory repo, `pipeline doctor` `install:engine-track`
      fails when the live pin is `no-frg-*` or has null evidence under
      pinned intent. Remediation names promote-from-FRG (or explicit
      skip). Non-factory hosts do not fail solely for this marker.
- [ ] Unit tests fail if default promote still accepts `no-frg-*` as
      production-quality, if a successful FRG promote writes
      `no-frg-*` or null evidence, or if factory doctor passes a
      `no-frg-*` pin under pinned intent. Tests inject I/O.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same
      change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This tightens existing pin, promote, and doctor law. -->

### Modified Capabilities

- `factory-two-track-engine-pinning`: A production-quality pin SHALL
  carry a real FRG `run_id` and a non-null evidence path. `no-frg-*`
  plus null evidence is only a skip-escape marker, not the default
  success path. Promote without skip SHALL refuse that marker.
- `engine-promote`: Non-skip promote SHALL write a production-quality
  pin from real FRG evidence. Resolved skip MAY write the marked
  non-production-quality pin. Same-version `no-frg-*` is not
  already-current success.
- `install-version-coherence`: Doctor `install:engine-track` SHALL fail
  closed on this factory repo when the live pin is `no-frg-*` or has
  null evidence under pinned intent.

## Impact

- **Pin core:** `core/scripts/production-engine-pin.ts`
  (`promoteProductionPin`, `buildPinWithoutFrg`,
  `evaluateEngineTrackCheck`, FRG refusal). Shared by
  `factory-pin promote` and `engine-promote`.
- **Promote CLI:** `core/scripts/stages/engine-promote.ts` already-current
  gate; `core/scripts/pipeline.ts` `factory-pin promote` wiring.
- **Doctor:** `install:engine-track` via `evaluateEngineTrackCheck`.
- **Tests:** `core/test/production-engine-pin.test.ts`,
  `core/test/engine-promote.test.ts`, `core/test/doctor.test.ts`.
  Inject I/O. No live pack, network, git, or subprocess.
- **Docs:** FRG runbook / factory-pin CLI text so a production pin
  after an FRG ship is a real `frg_run_id` + evidence path.
- **Mirror / gate:** regenerate `plugin/` after any `core/` edit.
  `npm run ci` must pass.
- **Depends on:** #1039 (Tugboat FRG pack; default promote omits
  `--skip-frg`). Same barrier as auto-tag (#1040). Program v1.39.0.
- **Does not:** invent SHAs; merge or tag; change Tugboat argv;
  disable review; add `auto_merge` or a merge stage; treat config
  `skip_frg` as a production-quality pin.
