## Context

See `proposal.md` for why. Current law and code:

- #1039 is on `main`. Tugboat default release/promote argv omit `--skip-frg`
  and compose an FRG pack. `pipeline engine-promote` already requires FRG
  unless shared skip is active (`--skip-frg` or `skip_frg: true`).
- `promoteProductionPin` still has `allowWithoutFrg`. That path writes
  `frg_run_id: "no-frg-<version>"` and `frg_evidence_path: null` and does
  not consult FRG. `engine-promote` passes that flag when skip resolves.
  `factory-pin promote` never sets it.
- The live factory pin is still a thin-ship marker
  (`no-frg-1.39.1`, `frg_evidence_path: null`). Parse accepts any
  non-empty `frg_run_id`. `evaluateEngineTrackCheck` does not inspect
  FRG quality. `engine-promote` treats same version+tag as
  already-current success.
- Existing two-track law already says promote requires an FRG pass. The
  gap is that `no-frg-*` is still a successful pin write and a silent
  doctor pass.

**Class vs site (engine-dogfood bar):** the site is "1.36/1.37 (and
current 1.39.1) pin uses `no-frg-*`." The class is: after the FRG ship
path returns, a **production-quality** pin MUST have a real FRG
`run_id` and a non-null evidence path. `no-frg-*` is only the explicit
skip marker. Shared surfaces: `promoteProductionPin` default refusal,
engine-promote already-current gate, doctor `install:engine-track`.
The next ship that would write or keep a `no-frg-*` pin as production
success is refused without a new mole issue.

## Goals / Non-Goals

**Goals:**

- Fail closed on default promote when FRG is missing, `no-frg-*`, or
  evidence path would be null.
- Keep one explicit skip write that is visibly not production-quality.
- Fail factory pinned doctor when the live pin is that marker.
- Stop treating a same-version `no-frg-*` pin as already-current.

**Non-Goals:**

- Inventing SHAs.
- Merging or tagging.
- Changing Tugboat argv or auto-tag (#1040).
- Adding `--skip-frg` to `factory-pin promote` (that command stays
  FRG-only).
- Rejecting `no-frg-*` at parse time (doctor must still read the
  marker).
- New pin schema fields or a second quality enum.

## Decisions

### 1. Shared promote core owns production-quality vs skip marker

**Choice:** Keep `promoteProductionPin` as the single writer. Default
(`allowWithoutFrg` false) SHALL refuse unless FRG lookup is `pass: true`
with a non-empty `run_id` that does not start with `no-frg-`, then write
that `run_id` and the existing relative evidence path
(`.agent-pipeline/frg/<version>/latest.json`). Resolved skip remains
the only caller of `buildPinWithoutFrg`.

`pipeline factory-pin promote` stays FRG-only (does not pass
`allowWithoutFrg`). `pipeline engine-promote` continues to map shared
skip onto that flag.

**Why:** The class lives in one writer. Two CLIs must not invent
different pin shapes. factory-pin is "from FRG"; skip stays on the
ship promote surface that already has `--skip-frg`.

**Alternatives considered:**

- Add `--skip-frg` to `factory-pin promote` → rejected; extra surface,
  same marker, no new operator need.
- Delete `buildPinWithoutFrg` entirely → rejected; the issue keeps an
  explicit skip write.
- Add `production_quality: false` to the pin schema → rejected; the
  existing `no-frg-*` + null path is already the mark.

### 2. Classifier is prefix `no-frg-` or null/empty evidence path

**Choice:** A pin (or FRG `run_id`) is not production-quality when
`frg_run_id` starts with `no-frg-` **or** `frg_evidence_path` is null
or empty. Default promote refuses both. Skip write MUST emit both
markers together.

**Why:** That is the current thin-ship shape. One helper can serve
promote refusal, already-current, and doctor.

**Alternatives considered:**

- Match only exact `no-frg-<this-version>` → rejected; a leftover
  `no-frg-1.36.0` on a later pin must still fail.
- Fail only on null path → rejected; a fake real path with
  `no-frg-*` would still look like success.

### 3. Same-version no-frg is not already-current on the default path

**Choice:** `engine-promote` already-current success requires
version+tag match **and** a production-quality pin, unless skip is
active. If the live pin is `no-frg-*` for that version and skip is
off, promote SHALL re-run `promoteProductionPin` (real FRG) or refuse.
It SHALL NOT return success with the marker pin.

**Why:** Otherwise the next default ship after #1039 is a no-op on the
existing `no-frg-1.39.1` pin.

**Alternatives considered:**

- Always rewrite the pin even when already production-quality →
  rejected; current skip-if-current stays for real FRG pins.
- Fail always and require a manual pin delete → rejected; a real FRG
  pass for the same version should be allowed to overwrite the marker.

### 4. Doctor fail-closed on factory pinned intent only

**Choice:** Extend `evaluateEngineTrackCheck` so pinned intent fails
when the loaded pin is not production-quality, even if version and
tag-install provenance match. Candidate intent reports the marker and
does not fail for it alone. Inactive two-track (non-factory) does not
fail for it.

**Why:** The issue says fail-closed if default promote already requires
FRG. That is now true. Warn-only would leave a green doctor on a
thin-ship pin.

**Alternatives considered:**

- Warn, not fail → rejected by the issue's fail-closed option.
- Fail on every host that can read a pin → rejected; non-factory
  doctor must not inherit factory pin policy.
- Fail under candidate intent too → rejected; candidate is a soak,
  not pinned production.

### 5. Parse stays permissive; skip pins remain readable

**Choice:** `parseProductionEnginePin` continues to accept `no-frg-*`
and null `frg_evidence_path`. Policy lives in promote + doctor, not
schema parse.

**Why:** Doctor and rollback must read the live marker. A parse reject
would hide the defect as "invalid pin" and lose the specific
remediation.

## Risks / Trade-offs

- **[Risk] Factory doctor goes red on the current `no-frg-1.39.1` pin.**
  → Mitigation: that is the intended signal. Remediation is
  non-skip promote after a real FRG pass, or explicit `--skip-frg`
  if the operator accepts a non-production-quality pin.
- **[Risk] Config `skip_frg: true` still writes a skip pin that
  doctor fails.** → Mitigation: intended. Config skip is not
  production-quality. This factory repo must not set `skip_frg: true`.
- **[Risk] Implementer rejects `no-frg-*` at parse and breaks skip
  write / doctor detail.** → Mitigation: spec and tests keep parse
  permissive and assert doctor names the marker.
- **[Trade-off] factory-pin promote has no skip.** Operators who want
  a skip pin use `engine-promote --skip-frg`. One escape surface.

## Migration Plan

1. Land promote refusal + already-current + doctor fail in one change
   after #1039 (already on `main`).
2. Next default `engine-promote --for X.Y.Z` either writes a real FRG
   pin or fails. It does not keep `no-frg-*` as success.
3. Operators refresh the installed engine after merge. Stale engines
   still accept `no-frg-*` until that install.

Rollback: revert the change. Thin-ship `no-frg-*` writes and silent
doctor pass return. No pin schema rollback.

## Open Questions

None that block specs or tasks.
