## Why

v1.39.7 Tugboat ship promoted the factory control pin to 1.39.7 peel
`e206cfda…`. Live Buzz `pipeline-supervisor` still defaulted
`AGENT_PIPELINE_PRODUCTION_PIN` to
`$HOME/.local/state/hermes-factory/production-engine-pin.json` (1.39.6).
Tugboat must not overwrite an already-set env (#1127), so a Buzz ship
doctors and promotes a **second** pin. The next train can fail or warn
`install:engine-track` while the control pin and installed CLI are already
1.39.7. Pin authority is the factory control checkout, not a Hermes-only
JSON.

## What Changes

- **One live production pin file.** On the factory plane, promote and the
  next doctor SHALL use
  `$REPO_DIR/.agent-pipeline/production-engine-pin.json` unless the operator
  explicitly sets `AGENT_PIPELINE_PRODUCTION_PIN` to that same path (or
  another path whose `version` / `git_sha` agree).
- **Buzz / Hermes supervisor MUST NOT default a second path.** The in-repo
  Hermes/Buzz supervisor SKILL and `env.example` SHALL NOT default or
  document
  `~/.local/state/hermes-factory/production-engine-pin.json`. Unset SHALL
  let Tugboat bind the control-checkout pin.
- **Doctor fail-closed on split pins.** On the factory plane, `pipeline
  doctor` SHALL **fail** (not only warn) when
  `AGENT_PIPELINE_PRODUCTION_PIN` points at a file whose `version` /
  `git_sha` disagree with the control-checkout pin.
- **Promote writes exactly one file.** `engine-promote` SHALL still write
  only the resolved path. It SHALL NOT dual-write a Hermes-state copy.
- **Drift-guard tests.** A unit test SHALL fail if the in-repo SKILL or
  `env.example` still defaults the Hermes-state pin path. A doctor test
  SHALL fail if env pin and control pin disagree and the result is pass.

**BREAKING** for a factory host whose supervisor SKILL or env still
defaults `AGENT_PIPELINE_PRODUCTION_PIN` to
`~/.local/state/hermes-factory/production-engine-pin.json`, or whose
doctor only warns when that file disagrees with the control pin.

This is class law, not a path-local copy of one pin file. Claude Code and
Hermes are both hosts. The next identical host default of a second pin
path SHALL fail the same tests. No new mole issue.

## Acceptance criteria

- [ ] In-repo `examples/supervisor/hermes/SKILL.md` (and any generated or
      installed copy the product owns) does not default
      `AGENT_PIPELINE_PRODUCTION_PIN` to
      `$HOME/.local/state/hermes-factory/production-engine-pin.json` or
      `~/.local/state/hermes-factory/production-engine-pin.json`.
- [ ] When that env is unset, Tugboat still binds
      `$REPO_DIR/.agent-pipeline/production-engine-pin.json` and does not
      overwrite an already-set operator value (#1127).
- [ ] `examples/supervisor/hermes/env.example` does not document a second
      live pin path. If the var is shown, it is the control-checkout pin.
- [ ] On the factory plane (`REPO_DIR` is the control checkout),
      `pipeline doctor` fails (status `"fail"`, not `"warn"` or `"pass"`)
      when `AGENT_PIPELINE_PRODUCTION_PIN` is set to a readable file whose
      `version` or `git_sha` disagrees with
      `$REPO_DIR/.agent-pipeline/production-engine-pin.json`.
- [ ] `engine-promote` writes exactly one file: the resolved pin path. It
      does not also write
      `~/.local/state/hermes-factory/production-engine-pin.json`.
- [ ] A unit test fails if the in-repo supervisor SKILL or `env.example`
      still defaults or documents the Hermes-state pin path.
- [ ] A doctor unit test fails if env pin and control pin disagree and
      the check result is pass.
- [ ] Hand-editing the Hermes-state JSON to catch up is not the product
      path. `no-frg-*` pins stay non-production. KEY_FILE engine loader
      and Tugboat skip-train stay out of this change. v1.40.1 packaging
      MUST NOT reintroduce a second live pin path.

## Capabilities

### New Capabilities

<!-- None. This is class law on existing pin, ship, doctor, and supervisor
     surfaces. A new capability folder would hide the class in a mole
     spec. -->

### Modified Capabilities

- `factory-two-track-engine-pinning`: Factory plane SHALL have one live
  production pin file (control-checkout pin unless env is an explicit
  override). Host supervisor SKILL SHALL NOT default a second path.
  Doctor SHALL fail when the env pin `version` / `git_sha` disagree with
  the control pin.
- `engine-promote`: Promote SHALL write exactly one file at the resolved
  path. It SHALL NOT dual-write a Hermes-state copy.
- `install-version-coherence`: Factory `pipeline doctor` SHALL fail (not
  only warn) when `AGENT_PIPELINE_PRODUCTION_PIN` and the control-checkout
  pin disagree on `version` or `git_sha`.
- `supervisor-ship-playbook`: In-repo Hermes/Buzz supervisor SKILL and
  `env.example` SHALL NOT default or document
  `~/.local/state/hermes-factory/production-engine-pin.json`. A unit test
  SHALL fail if that default returns.
- `tugboat-thin-ship`: Unset `AGENT_PIPELINE_PRODUCTION_PIN` SHALL still
  export the control-checkout pin. An already-set operator value SHALL
  still be left unchanged. A SKILL default of a second path is not a
  legitimate operator override.

## Impact

- **Supervisor examples:** `examples/supervisor/hermes/SKILL.md`,
  `examples/supervisor/hermes/env.example`, and any product-owned
  generated or installed copy of that SKILL. Live
  `~/.hermes/profiles/pipeline-factory/skills/pipeline-supervisor/SKILL.md`
  is the site that already defaulted the Hermes-state path; the in-repo
  SKILL is the class source.
- **Pin / promote / doctor:** `core/scripts/production-engine-pin.ts`,
  `core/scripts/stages/engine-promote.ts`, `core/scripts/stages/doctor.ts`.
  Tugboat `export_factory_production_pin` stays preserve-if-set (#1127).
- **Tests:** hermetic SKILL / `env.example` drift guard; hermetic doctor
  fail when env pin and control pin disagree; hermetic promote single-write
  (no Hermes-state dual-write). No real network, git, or subprocess in
  unit tests.
- **Docs:** supervisor / ship-milestone / hermes-supervisor-deployment
  MUST NOT document a second live pin path. v1.40.1 packaging MAY
  template env; it MUST NOT reintroduce a second pin.
- **Mirror / gate:** regenerate `plugin/` after any `core/` edit.
  `npm run ci` must pass.
- **Does not:** hand-edit Hermes-state JSON to catch up; treat `no-frg-*`
  as production; change KEY_FILE engine loader (sibling v1.39.8); change
  Tugboat skip-train (sibling v1.39.8); add merge inside advance/loop;
  add `auto_merge` or a merge stage; reverse papercut backlog policy
  (#538).
