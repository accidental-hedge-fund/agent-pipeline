## Why

Packaging and install surfaces still publish contradictory runtime and loop
prerequisites. Root `package.json` declares `engines.node: ">=18"` while the
core, launchers, README, and CI require Node ≥ 24; README install examples still
pin the ancient tag `v1.2.1` (package is 1.28.x); and installer/doctor messaging
still treats external `goal-loop` as required for `/pipeline:loop` after the
in-repo durable loop (#512 / #609) made that skill optional/legacy. Users and
`pipeline doctor` both get false signals from these lies.

## What Changes

- Align root package `engines.node` with the real runtime floor (**≥ 24**),
  matching `core/package.json`, launchers, and docs — not a silent dual-story
  about “installer-only” engines.
- Add a CI-enforced packaging coherence gate that fails when:
  - root `package.json` `version` ≠ `core/package.json` `version`, or
  - root `engines.node` is looser than / disagrees with the core Node floor.
- Update README install pins and “recommended”/`npx` examples so they no longer
  cite `v1.2.1`; use the current release tag or tag-agnostic “pin a released
  tag” wording without ancient version numbers.
- Demote/delete install and doctor messaging that claims goal-loop is required
  for `/pipeline:loop` / `$pipeline:loop`.
- Change `loop:contract-coherence` so absence of goal-loop is **skip** or
  **warn** (not **fail**); keep hard-fail only for a *discovered* install whose
  schema ids are outside the supported set. Align comments/docs with #512
  reality (in-repo loop; external goal-loop is legacy optional).
- Keep `npm run ci` green.

## Acceptance criteria

- [ ] Root `package.json` `engines.node` is `>=24` (or an equivalent range that
      still requires major ≥ 24) and matches the runtime floor enforced by
      launchers and `core/package.json`.
- [ ] CI fails when root `package.json.version` differs from
      `core/package.json.version`.
- [ ] CI fails when root `engines.node` allows a major version below the core’s
      declared Node floor (today: 24).
- [ ] README install / pin examples do not reference `v1.2.1` or any other
      historical pin as the recommended install; they either use the current
      release tag or describe pinning without embedding a stale version.
- [ ] Installer no longer states that `/pipeline:loop` or `$pipeline:loop` is
      unavailable without an external goal-loop install.
- [ ] `pipeline doctor` does not fail `loop:contract-coherence` solely because
      goal-loop is absent (status is `skip` or `warn`, not `fail`).
- [ ] When a goal-loop install *is* discovered with schema ids outside the
      supported set, doctor and installer still fail with remediation naming
      both sides.
- [ ] Code comments and README doctor-check table for `loop:contract-coherence`
      match the post-#512 optional/legacy semantics.
- [ ] `npm run ci` passes.

## Capabilities

### New Capabilities

- `packaging-coherence`: CI and package-metadata invariants that keep root vs
  core `version` and Node `engines` floors honest, so packaging lies cannot
  land without failing the gate.

### Modified Capabilities

- `install-version-coherence`: Revise `loop:contract-coherence` so missing
  goal-loop is non-blocking; keep incompatible discovered installs as failures;
  align the “shared by doctor / installer / loop run-start” wording with
  post-#512 reality (run-start uses in-repo store schema check, not external
  goal-loop discovery).
- `readme-user-clarity`: Install pins and goal-loop/loop prerequisite text in
  the README must match current package version practice and in-repo loop
  behavior (no stale tag pins; no “goal-loop required for loop” claims).

## Impact

- **Surfaces**: root `package.json`, `core/package.json` (read for coherence;
  version already aligned at 1.28.x), `README.md`, `scripts/install.mjs`,
  `core/scripts/loop-preflight.ts`, `core/scripts/stages/doctor.ts`, possibly
  `scripts/install.test.mjs` / `core/test/loop-preflight.test.ts` /
  `core/test/doctor.test.ts`, and a small CI script or existing scripts-test
  asserting packaging coherence.
- **User-visible**: doctor on hosts without goal-loop stops false-failing;
  install output no longer misleads about loop availability; install docs stop
  recommending a years-stale tag; npm/engines consumers see the true Node
  floor.
- **Non-goals**: CLAUDE_CONFIG_DIR command hardcoding; marketplace plugin update
  locks; changing the in-repo durable loop engine itself; removing legacy
  goal-loop import/resume paths.
- **Related**: #609 (closed), #512 (closed), architectural review 2026-07-27.
