## Context

See `proposal.md` for why. Current law and code:

- Tugboat (`examples/supervisor/shell/tugboat.sh`) is the Option 1 thin
  composer. `ship_one` is train → `release --no-edit --skip-frg` → CI
  wait → `release finish` → publication wait →
  `engine-promote --skip-frg`. The chain playbook hard-codes the same
  skip flags. `core/test/tugboat.test.ts` asserts those flags and
  asserts the `ship_one` body does **not** contain
  `factory-release prepare`.
- #1038 is on base. `isHonestPost133FrgPass` is the single skip-frg
  restore predicate. Living `tugboat-thin-ship` still says keep default
  `--skip-frg` and do not add an FRG pack phase until this child.
- `pipeline factory-release prepare --request <abs.json> --json` is the
  durable #1037 pack driver. First ticks return `in_progress`. A
  terminal bound loop is scored with `factory-gate --from-run` (no
  `--observations`). Genuine pass writes
  `.agent-pipeline/frg/<ver>/latest.json`. Without production
  attestation the command returns `awaiting_frg_attestation` and does
  **not** open a release PR. `status: "complete"` also opens the
  release PR via shared `runRelease` after attestation.
- `pipeline release` without `--skip-frg` already fail-closes via
  `requireFrgPassForRelease` when that version has no
  `latest.json` `pass: true`. Tugboat does not need a second release
  gate.

**Class vs site (engine-dogfood bar):** the site is "Tugboat still
passes `--skip-frg`." The class is: after an accepted post-1.33 honest
pass exists, the factory ship path default is **FRG pack then release**.
Skip is a logged operator escape only. Shared surfaces: Tugboat phase
list, default argv, escape + reason, playbook default argv, Hermes
skill, ship runbook. The next ship does not need a new mole to remember
FRG.

## Goals / Non-Goals

**Goals:**

- Insert one Tugboat phase after train and before release that
  composes the existing #1037 pack command.
- Drop `--skip-frg` from default Tugboat (and playbook) release and
  promote argv for this repo.
- Keep an explicit skip escape with a required logged reason.
- Keep Tugboat thin: wait + notify + existing CLI verbs only.

**Non-Goals:**

- Auto-tag FRG (#1040) or refusing `no-frg-*` pins (#1041).
- `pipeline ship`, grant factory, or a second ship / pack brain.
- Attestation signing, merge, tag, pin, or install inside the pack
  phase.
- Changing `pipeline release` / `engine-promote` flag schemas. Those
  commands already treat `--skip-frg` as opt-out.
- Waiting for `factory-release prepare` `status: "complete"` as the
  pack-done signal (that tick needs attestation and opens the PR).

## Decisions

### 1. Pack phase composes `factory-release prepare`; it does not
become a second runner

**Choice:** After train is complete (or resumed complete), Tugboat
SHALL write one secret-free request JSON under the ship run dir and
invoke `pipeline factory-release prepare --request <abs.json> --json`.
It SHALL re-invoke the **unchanged** request until a pack-done or
pack-fail signal (Decision 2). It SHALL NOT start `pipeline loop`,
`factory-gate startLoop`, or a one-off pack script.

The request uses the documented #1037 schema
(`schema_version: 1`, `kind: "factory_release_prepare_request"`):
`action_id`, `repository`, `base_branch`, `target_version` (bare
`X.Y.Z`), `integrated_candidate.git_sha`, and
`frg_manifest.{pack_id,sha256}`. No credentials, executable paths,
modules, network targets, or caller-authored `pass` claims.

When the installed production engine is one release behind the
candidate that provides prepare, Tugboat MAY invoke the same command
from the clean integrated candidate (already allowed by living
`release-sub-command` law). That is still compose, not a second
protocol.

**Why:** Issue #1039 names `factory-release prepare` / the #1037
sequence. A second runner would fork the durable path #1037 just
fixed.

**Alternatives considered:**

- Call `pipeline factory-gate --for X.Y.Z` only → rejected; that
  skips the bound-pack start/resume protocol.
- New `pipeline ship` or Tugboat-local pack loop → rejected;
  second ship brain.
- Let `factory-release prepare` also open the release PR
  (`status: "complete"`) and drop the release phase → rejected;
  that tick requires attestation Tugboat must not sign, and the
  issue's acceptance sequence is pack **then** `pipeline release`.

### 2. Pack-done is `awaiting_frg_attestation` or this version's
`latest.json` `pass: true`

**Choice:** The frg-pack phase is done when **either**:

1. prepare JSON `status` is `awaiting_frg_attestation`, or
2. `.agent-pipeline/frg/<X.Y.Z>/latest.json` exists with
   `pass: true`.

Then Tugboat proceeds to `pipeline release X.Y.Z --no-edit` **without**
`--skip-frg`. Existing open-PR reuse still applies.

The phase fails closed when prepare reports a failed / missing FRG
status, when `latest.json` is `pass: false` after a terminal score, or
when the wait budget is exhausted while status stays `in_progress`.
Tugboat SHALL NOT invent `pass: true` and SHALL NOT hand-edit
evidence.

If a re-invoke already returns `status: "complete"` with an open
release PR, Tugboat SHALL treat pack as done and SHALL reuse that PR
in the release-prepare phase (idempotent). It still SHALL NOT pass
`--skip-frg`.

Wait/re-invoke uses the existing Tugboat wait budget pattern
(`RELEASE_WAIT_ATTEMPTS` / `RELEASE_WAIT_SLEEP_S` or a sibling
`FRG_WAIT_*` pair). No new durable ledger.

**Why:** Prepare's honest unsigned pass stops at
`awaiting_frg_attestation` and does not open a PR. That is the pack
output Tugboat needs. `pipeline release` then consumes
`latest.json` through the existing fail-closed gate.

**Alternatives considered:**

- Wait for `status: "complete"` → rejected; attestation + hidden
  release builder inside the pack phase.
- Parse `isHonestPost133FrgPass` in bash → rejected; Tugboat stays a
  thin reader of prepare JSON / `latest.json` `pass`. The #1038
  checker remains the restore predicate and the prepare persist
  gate, not a Tugboat reimplementation.

### 3. Default argv omits `--skip-frg`; escape is flag or env plus
reason

**Choice:**

- Default Tugboat release argv: `release "$version" --no-edit`
- Default Tugboat promote argv:
  `engine-promote --for "$version" --host "$ENGINE_PROMOTE_HOST" --json`
- Escape: Tugboat `--skip-frg` **or** env `TUGBOAT_SKIP_FRG=1`, both
  requiring a non-empty reason (`--skip-frg-reason` or
  `TUGBOAT_SKIP_FRG_REASON`). Tugboat SHALL write that reason into
  ship state/log, omit the frg-pack phase, and pass `--skip-frg` to
  release and promote.
- Missing reason with skip requested SHALL fail closed before train
  mutation for that milestone. Empty reason SHALL NOT skip.

This is the default for the shipped Option 1 composer used by
`accidental-hedge-fund/agent-pipeline`. Tugboat SHALL NOT special-case
the GitHub owner/repo string as a second policy brain.

**Why:** The issue asks for default no-skip on this repo and a logged
escape. A repo-name switch would be a second policy.

**Alternatives considered:**

- Keep skip unless `isHonestPost133FrgPass` is true at runtime →
  rejected as the ongoing default. #1038 is the land-this-change
  precondition. After this change, every ship runs the pack (or
  the logged escape).
- Escape without a reason → rejected by the issue.

### 4. Playbook drops default skip; it is not a second pack brain

**Choice:** `pipeline-ship-playbook.sh` SHALL stop hard-coding
`--skip-frg` on release and promote. If the playbook remains an
installed alternate, it SHALL compose the same
`factory-release prepare` request/re-invoke sequence before release,
or fail closed when `pipeline release` finds no FRG. It SHALL NOT
grow a grant factory or a different pack protocol.

Doctor / source assertions that currently require `--skip-frg` on
default playbook argv SHALL flip with Tugboat.

**Why:** The issue names playbook hard-code as part of the defect.
Leaving skip on the alternate path would keep the old default alive.

**Alternatives considered:**

- Leave playbook on `--skip-frg` because Tugboat is primary →
  rejected; two shipped defaults.

### 5. Docs and Hermes skill follow the composer, not the old advisory
line

**Choice:** Update `examples/supervisor/hermes/SKILL.md` and
`docs/runbooks/ship-milestone.md` so the default sequence is train →
FRG pack → release (no skip) → finish → promote. Remove the
"FRG is not part of thin ship / optional advisory" paragraph. Document
`--skip-frg` / `TUGBOAT_SKIP_FRG` + reason as escape only. Update the
#1038 runbook sentence that said this child had not landed.

**Why:** Hermes currently tells the host to detach Tugboat and not
reimplement phases. The skill must not keep teaching skip-by-default.

## Risks / Trade-offs

- **[Risk] Pack loop is long; Tugboat blocks the ship process.** →
  Mitigation: Tugboat already detaches the whole ship. The pack phase
  is another wait/re-invoke loop inside that detached process, same
  as CI wait. Chat stays non-blocking.
- **[Risk] Request JSON is wrong or secret-bearing.** → Mitigation:
  write only documented identity fields from ship coordinates under
  the run dir. Tests assert the request file has no credential keys
  and has `kind: "factory_release_prepare_request"`.
- **[Risk] Implementer waits for prepare `complete` and Tugboat tries
  to attest.** → Mitigation: spec and composer tests treat
  `awaiting_frg_attestation` as pack-done. Tugboat source MUST NOT
  contain attestor / HMAC / grant-factory markers.
- **[Risk] Default no-skip ships fail when FRG tooling is down.** →
  Mitigation: that is the intended fail-closed behavior. Escape with
  a logged reason remains.
- **[Trade-off] Playbook gains the same pack compose.** Duplicate
  shell is acceptable because playbook is already a second composer.
  Do not extract a third ship binary.

## Migration Plan

1. Land composer + test + docs/skill changes on this branch after
   #1038 is on the integration base (already true on `main`).
2. Operators refresh `~/.local/bin/tugboat` from
   `examples/supervisor/shell/` (existing install-parity / doctor
   path). Stale binaries keep skip until refresh.
3. Next `Ship milestone vX.Y.Z` runs pack then release. Use
   `--skip-frg` + reason only as escape.
4. Auto-tag (#1040) and pin (#1041) remain later.

Rollback: revert the composer/docs change. `--skip-frg` becomes the
default again. No engine schema rollback is required.

## Open Questions

None that block specs or tasks. Wait-budget env name (`FRG_WAIT_*` vs
reuse `RELEASE_WAIT_*`) is an implementation detail.
