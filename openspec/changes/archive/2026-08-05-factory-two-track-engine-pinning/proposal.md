## Why

The factory currently dogfoods the engine build it just released, so every engine regression
immediately degrades the factory's own ability to repair that regression. The v1.29.0 milestone
soak (`loop-4d2de11c6c029a2f-s1`) is the proof: ~3/11 ready-to-deploy with six engine defects filed —
and the same engine build then had to repair itself. Slowing releases alone also slows delivery of
engine fixes into dogfood. The standard self-hosting answer is **two tracks**: production runs
execute a **pinned last-FRG-passed release**; the **candidate** soaks only under FRG/eval until a
pass promotes the pin. This also closes the stale-install / phantom-defect attribution hole
(#176-class): every run must disclose which track (version+SHA) actually executed.

## What Changes

- **Pinned production track** — daily/product `pipeline loop` and ordinary advance runs for factory
  dogfood SHALL execute the **last FRG-passed release** via the existing tag-pinned install path
  (`npx …#vX.Y.Z install`), not an unpinned working tree or floating default-branch install.
- **Candidate soak track** — the release candidate (working tree / release branch / unreleased
  build) SHALL be exercised only by FRG Layer B soaks and eval campaigns until its FRG gate
  passes; ordinary production/dogfood loops SHALL NOT silently run the candidate.
- **Promotion** — a recorded FRG pass for version `X.Y.Z` is the sole automatic eligibility signal
  to **promote** the production pin to that version (plus its release SHA when known). Promotion
  is an explicit, audited step (operator or driver-assisted), never an unattended merge/tag.
- **Rollback** — restore production capacity by repointing the pin to the previous FRG-passed
  release and reinstalling; document the procedure as a first-class operator path.
- **Track disclosure** — `pipeline doctor` and per-run evidence (`run.json` / evidence bundle)
  SHALL surface which track executed: `pinned` (version + pin metadata) vs `candidate` (version +
  engine root / SHA), so defects are attributable to the correct build.
- **Config + docs** — describe the two tracks, pin location, promote/rollback commands or steps,
  and how FRG pass feeds the pin; cross-link the FRG runbook.
- **Gates** — `npm run ci` green; regenerate `plugin/` after any `core/` changes.

Non-goals: FRG pack composition (separate issue — this **consumes** the FRG pass artifact);
any auto-merge / auto-release / unattended tag authority change; replacing mid-run snapshot
isolation (#450) or install version-coherence/freshness checks (they remain; this adds track
semantics on top).

## Acceptance Criteria

- [ ] A documented **production pin** names the last FRG-passed engine version (and SHA when
      known) and is the authoritative target for factory production/dogfood runs.
- [ ] Ordinary production/dogfood `pipeline loop` / advance runs that claim the production track
      execute the pinned install (version matches the pin), not an unpinned working-tree or
      floating default-branch install.
- [ ] FRG Layer B (and documented eval campaigns) are the allowed soaks for the **candidate**
      track; a candidate run is labeled as such in evidence and is not mistaken for a production
      pin run.
- [ ] When FRG evidence for version `X.Y.Z` has `pass: true`, the documented promote path updates
      the production pin to `X.Y.Z` (and release SHA when known); absence or `pass: false` does
      not promote.
- [ ] Rollback is documented as repointing the pin to the previous FRG-passed version and
      reinstalling from that tag; after rollback, doctor reports the restored pin.
- [ ] `pipeline doctor` reports active track, pinned target version, and installed/running version
      (pass when production track is coherent with the pin; fail or warn with remediation when
      production intent is configured but install ≠ pin).
- [ ] Run evidence (`run.json` and/or evidence bundle) records `engine.track` (`pinned` |
      `candidate`) plus version and root/SHA identity for the run.
- [ ] README / FRG runbook / config docs describe the two tracks and promote/rollback procedures.
- [ ] Unit tests cover pin resolution, track classification, doctor disclosure, and promotion
      refusal without FRG pass (injected deps; no real network/git/subprocess).
- [ ] `npm run ci` green; `plugin/` regenerated when `core/` changes; no auto-merge path introduced.

## Capabilities

### New Capabilities

- `factory-two-track-engine-pinning`: Two-track engine execution model — production pin (last
  FRG-passed release), candidate soak track, promotion from FRG pass, rollback procedure, and
  track disclosure contracts for doctor and run evidence.

### Modified Capabilities

- `install-version-coherence`: Doctor SHALL surface engine track (pinned vs candidate) alongside
  version coherence, and SHALL detect production-track install vs pin mismatch.
- `run-directory-layout`: `run.json` / engine identity SHALL record the engine track the run
  executed under (`pinned` | `candidate`) in addition to version, root, and template fingerprint.
- `factory-reliability-gate`: An FRG pass for a version is the eligibility signal to promote the
  production pin to that version; FRG Layer B is the designated candidate-track soak. FRG does
  not merge, auto-tag, or auto-merge.

## Impact

- **Specs:** new `factory-two-track-engine-pinning`; additive deltas on
  `install-version-coherence`, `run-directory-layout`, `factory-reliability-gate`.
- **Code (implementation, not this proposal step):** pin resolution module + config/docs path;
  doctor check for track/pin coherence; run-dir engine identity field; optional factory-gate
  promote helper or documented operator step; tests under `core/test/`; `plugin/` mirror regen.
- **Process:** factory dogfood loops install/run from pin; candidates soak only via FRG/eval;
  promote after FRG pass; rollback by repoint+reinstall.
- **Does not:** change FRG pack composition; introduce auto-merge or unattended release; remove
  existing install coherence/freshness or mid-run snapshot isolation.
- **Precedent:** tag-pinned install (`#vX.Y.Z`), FRG pass artifacts, doctor version-coherence,
  run-engine identity/drift (#450 / run-directory-layout).
- **Siblings:** FRG pack composition issues remain separate; this consumes FRG pass artifacts only.
