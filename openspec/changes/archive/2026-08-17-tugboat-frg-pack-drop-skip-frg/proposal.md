## Why

Tugboat and the chain playbook still hard-code `pipeline release --skip-frg`
and `pipeline engine-promote --skip-frg`. After #962 that skip was the
correct thin-path default: Factory Reliability Gate (FRG) had no honest
post-1.33 pack. #1038 now supplies `isHonestPost133FrgPass` and one
accepted post-1.33 `pass: true`. The skip default is now the wrong
policy for `accidental-hedge-fund/agent-pipeline`.

## What Changes

- **Tugboat grows one FRG pack phase.** After a successful
  `pipeline train --milestone vX.Y.Z --merge` and **before**
  `pipeline release`, Tugboat SHALL run the automated FRG pack by
  composing `pipeline factory-release prepare` (or the documented
  #1037 CLI sequence). It SHALL NOT implement a second pack runner,
  grant factory, or `pipeline ship` product path.
- **Default argv drops `--skip-frg`.** For this factory repo's Option 1
  ship path, Tugboat SHALL invoke `pipeline release` and
  `pipeline engine-promote` **without** `--skip-frg`.
- **Operator escape stays explicit.** `--skip-frg` or an equivalent env
  remains an operator escape that MUST carry a logged reason. Skip is
  not the default. Escape MAY omit the FRG pack phase.
- **Hermes `pipeline-supervisor` skill and ship runbook.** Default
  documented sequence is train → FRG pack → release → finish →
  promote. Skip is documented as escape only.
- **Chain playbook default argv aligns.** The documented alternate
  playbook SHALL stop hard-coding `--skip-frg` on release and promote.
- **Reuse #1038 checker.** This change consumes
  `isHonestPost133FrgPass`. It SHALL NOT invent a second honest-pass
  definition.

**BREAKING** for operators or hosts that still expect thin ship to skip
FRG by default. A ship without version FRG evidence now fail-closes at
release (or at the new pack phase) unless the operator uses the logged
escape.

## Acceptance Criteria

- [ ] A successful Tugboat ship for milestone `vX.Y.Z` records phase
      order train → **frg-pack** → release-prepare → CI wait → release
      finish → publication wait → engine-promote.
- [ ] Default Tugboat `pipeline release` argv for this repo has **no**
      `--skip-frg`. Default Tugboat `pipeline engine-promote` argv for
      this repo has **no** `--skip-frg`.
- [ ] The FRG pack phase composes `pipeline factory-release prepare
      --request <abs.json> --json` (or the documented #1037 sequence)
      and re-invokes until `.agent-pipeline/frg/<X.Y.Z>/latest.json`
      is an accepted honest pass **or** the pack fails closed. It does
      not invent `pass: true`.
- [ ] A failed or missing pack stops Tugboat **before**
      `pipeline release`. Tugboat does not open or finish a release PR
      for that version on that path.
- [ ] Explicit Tugboat `--skip-frg` (or documented env) with a
      non-empty reason omits the pack phase, passes `--skip-frg` to
      release and promote, and writes that reason into ship state or
      log. Missing reason fails closed and does not skip.
- [ ] Unit / composer tests fail if default Tugboat release or promote
      argv still contain `--skip-frg`, if the default `ship_one` body
      has no frg-pack phase, or if the escape path cannot still pass
      `--skip-frg`. Tests inject I/O and do not start a live pack.
- [ ] Hermes `pipeline-supervisor` skill and
      `docs/runbooks/ship-milestone.md` say the default is FRG pack
      then release. They document skip as operator escape only. They
      no longer say FRG is optional / advisory on thin ship.
- [ ] The documented alternate playbook default release and promote
      argv also omit `--skip-frg`.
- [ ] Tugboat remains a thin composer: no grant factory, no second
      ship brain, no `pipeline ship` product subcommand, no merge
      inside advance/loop, no auto-tag or pin default change.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same
      change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends existing Tugboat, FRG, and playbook law. -->

### Modified Capabilities

- `tugboat-thin-ship`: Replace the keep-skip rule. The fixed thin
  sequence SHALL insert one FRG pack phase after train and before
  release. Default release and promote argv SHALL omit `--skip-frg`.
  An operator escape with a logged reason MAY skip the pack and pass
  `--skip-frg`. Hermes / runbook text SHALL match that default.
- `factory-reliability-gate`: The skip-frg default restore is this
  change. After an accepted post-1.33 honest pass exists, Tugboat
  default argv SHALL drop `--skip-frg` and SHALL run the pack. The
  restore still reuses `isHonestPost133FrgPass`. It SHALL NOT invent
  a second pass definition. Auto-tag (#1040) and pin (#1041) stay
  later children.
- `supervisor-ship-playbook`: Default playbook release and promote
  argv SHALL omit the thin-path `--skip-frg` flag. Promote host
  default `all` is unchanged.

## Impact

- **Composer:** `examples/supervisor/shell/tugboat.sh` (new
  `frg-pack` phase; default release / promote argv; `--skip-frg` /
  env escape + reason log). Sibling
  `examples/supervisor/shell/pipeline-ship-playbook.sh` default argv.
- **Tests:** `core/test/tugboat.test.ts` (and doctor / playbook source
  assertions that currently require `--skip-frg` on default argv).
- **Docs / skill:** `docs/runbooks/ship-milestone.md`,
  `docs/factory-reliability-gate-runbook.md` skip-frg restore
  paragraph, `examples/supervisor/hermes/SKILL.md`.
- **Engine:** Prefer compose-only. `pipeline release` and
  `engine-promote` already fail closed without FRG unless
  `--skip-frg`. Do not add `pipeline ship`, grant factory, or a
  second pack runner. If Tugboat needs a small request-JSON helper,
  keep it secret-free and bound to ship coordinates.
- **Depends on:** #1038 (honest-pass helper + one accepted post-1.33
  `pass: true`). Parent tracker #1035. Blocks later auto-tag (#1040)
  and pin (#1041) children.
- **Does not:** flip skip without #1038 proof; change auto-tag or
  `no-frg-*` pin defaults; add merge / tag / promote / install
  authority to the pack phase; add attestation signing to Tugboat;
  add a grant factory or `pipeline ship` control plane.
