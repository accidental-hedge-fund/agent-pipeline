## Why

After v1.39.3 promote, the next ship (v1.39.4) failed `pipeline doctor`
`install:engine-track`. `engine-promote` wrote the production-quality pin
into the promote `repoDir` (a worktree). The next train doctor read a
different pin and still saw committed `no-frg-1.39.1`. Host Buzz still
launched a stale `pipeline-ship-playbook` that hard-coded `--skip-frg`.
Untracked `.agent-pipeline/frg/<ver>/latest.json` then failed
`worktree-clean` on the protected factory checkout. A human had to copy
the 1.39.3 FRG pin by hand. That is not a ship end.

## What Changes

- **Shared factory pin path.** Tugboat and the host `pipeline` launcher
  SHALL export `AGENT_PIPELINE_PRODUCTION_PIN` to the factory pin file
  (default: factory control checkout
  `.agent-pipeline/production-engine-pin.json`) when the operator has
  not set it. `engine-promote` and the next `pipeline train` /
  `pipeline doctor` SHALL read and write that same path.
- **Promote does not write a worktree-local pin as factory authority.**
  A non-skip promote of version N SHALL update the exported factory pin
  to a production-quality `frg-…` pin for N. It SHALL NOT leave the next
  train reading a stale `no-frg-*` pin because promote wrote into a
  worktree.
- **Default ship path stays FRG-on.** Default Tugboat and host launcher
  argv SHALL NOT pass `--skip-frg`. Escape still requires a logged
  reason.
- **FRG tree is an ignored engine artifact.** `.agent-pipeline/frg/`
  (including `latest.json`) SHALL join the engine artifact ignore
  contract and this repo's `.gitignore`. A pack or promote write SHALL
  NOT fail the next train's `worktree-clean`. Host-only `skip-worktree`
  is not the product fix.
- **Doctor / unit bite.** Doctor or a unit test SHALL fail if the
  installed Tugboat or `pipeline-ship-playbook` is the old skip-frg
  playbook. A unit or doctor test SHALL fail if default promote would
  write `no-frg-*` without an explicit skip.
- **Next-train invariant.** After a non-skip promote of version N,
  doctor on the factory control checkout (clean tree, same pin path)
  SHALL accept pin `frg-…` for N so version N+1 train can start with no
  manual pin copy.

**BREAKING** for a factory host whose promote still writes only a
worktree-local pin, whose installed ship composer still hard-codes
`--skip-frg`, or whose operators relied on committing unignored
`.agent-pipeline/frg/` leftovers on the protected checkout.

## Acceptance criteria

- [ ] Tugboat and the host `pipeline` launcher export
      `AGENT_PIPELINE_PRODUCTION_PIN` to the factory pin file when
      unset. Default path is the factory control checkout
      `.agent-pipeline/production-engine-pin.json`.
- [ ] `engine-promote --for N` without skip writes that exported path.
      The next `pipeline doctor` / `pipeline train` on the factory
      control checkout reads the same path.
- [ ] After that promote, the factory pin is production-quality
      (`frg_run_id` does not start with `no-frg-`; `frg_evidence_path`
      is non-null) for version N.
- [ ] Default Tugboat and host launcher release / promote argv do not
      include `--skip-frg`. Escape still requires a non-empty logged
      reason.
- [ ] `.agent-pipeline/frg/` is in the exported artifact ignore
      contract and this repo's root `.gitignore`. An uncommitted
      `latest.json` on the factory control checkout does not fail
      `worktree-clean`.
- [ ] Doctor or a unit test fails when the installed Tugboat or
      `pipeline-ship-playbook` still hard-codes default `--skip-frg`.
- [ ] A unit or doctor test fails if default promote would write
      `no-frg-*` without explicit skip.
- [ ] After promote of N, doctor on the factory control checkout
      (clean tree, same pin path) passes `install:engine-track` for
      pin `frg-…` of N. Version N+1 train does not need a manual pin
      copy.
- [ ] Host-only `skip-worktree` is not the product fix. v1.39.2 is
      not treated as FRG-done.

## Capabilities

### New Capabilities

<!-- None. This is class law on existing pin, ship, ignore, and doctor
     surfaces. A new capability folder would hide the class in a mole
     spec. -->

### Modified Capabilities

- `factory-two-track-engine-pinning`: Factory ship and doctor SHALL
  share one exported pin path (`AGENT_PIPELINE_PRODUCTION_PIN`, default
  factory pin file). Promote of N SHALL leave that path as a
  production-quality `frg-…` pin so N+1 train can start.
- `engine-promote`: Non-skip promote SHALL write the exported factory
  pin, not a worktree-local pin when factory ship/doctor authority is
  in effect. Default promote SHALL NOT write `no-frg-*`.
- `tugboat-thin-ship`: Tugboat SHALL export
  `AGENT_PIPELINE_PRODUCTION_PIN` to the factory pin when unset.
  Default argv SHALL stay without `--skip-frg`.
- `supervisor-ship-playbook`: Installed Tugboat or chain playbook that
  still hard-codes default `--skip-frg` SHALL fail doctor. Default
  playbook argv SHALL omit `--skip-frg`.
- `engine-artifact-ignore-contract`: The contract and this repo
  `.gitignore` SHALL include `.agent-pipeline/frg/`.
- `factory-reliability-gate`: The "FRG tree is not gitignored /
  operators must commit `latest.json` onto the protected checkout" bar
  is superseded for worktree-clean. Local `latest.json` remains the
  ship-host lookup. Auto-tag still requires release-eligible evidence
  for the version.
- `install-version-coherence`: Factory doctor `install:engine-track`
  SHALL pass after promote of N when the shared pin path holds a
  production-quality `frg-…` pin for N on a clean factory control
  checkout.

## Impact

- **Ship composers:** `examples/supervisor/shell/tugboat.sh`, host
  `pipeline` launcher (`examples/supervisor/shell/pipeline-launcher.sh`
  and/or `scripts/pipeline-launcher.mjs`), alternate
  `pipeline-ship-playbook.sh`.
- **Pin / promote / doctor:** `core/scripts/production-engine-pin.ts`,
  `core/scripts/stages/engine-promote.ts`, `core/scripts/stages/doctor.ts`,
  `core/scripts/pipeline.ts` pin wiring.
- **Ignore contract:** `core/scripts/artifact-ignore.ts`, root
  `.gitignore`, drift-guard tests.
- **Docs:** FRG runbook commit bar, ship-milestone runbook, config
  pin-path text. Release PR MAY still `git add -f` that version's
  evidence so auto-tag sees `latest.json`. That is a release-branch
  attachment, not a reason to leave `.agent-pipeline/frg/` unignored
  on the factory control checkout.
- **Tests:** hermetic pin-path, promote-refusal, ignore-contract, and
  installed-composer skip-frg doctor checks. No live pack, network,
  git, or subprocess in unit tests.
- **Mirror / gate:** regenerate `plugin/` after any `core/` edit.
  `npm run ci` must pass.
- **Does not:** call v1.39.2 FRG-done; use host-only `skip-worktree`
  as the product fix; add merge inside advance/loop; add `auto_merge`
  or a merge stage; invent a second pin file format; treat config
  `skip_frg` as a production-quality pin.
