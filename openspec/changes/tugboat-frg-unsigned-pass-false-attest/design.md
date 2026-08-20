## Context

See `proposal.md` for why. Current law and code:

- `factory-gate` mint sets `pass = structuralPass && canSign`. Without
  `PIPELINE_FRG_ATTESTATION_KEY`, unsigned evidence is honest
  `pass: false` plus note `release-eligible attestation omitted`. Unsigned
  MUST NOT claim `pass: true` (#757).
- `factory-release prepare` scores the terminal bound pack with
  `requireAttestation: false`, then treats `scored.pass === false` as
  structural fail. It returns `status: "failed"` and
  `defect_class: "frg_not_eligible"`. Living `release-sub-command` already
  requires `awaiting_frg_attestation` for complete unsigned artifacts
  with no production attestation. The implementation violates that for
  this shape.
- Tugboat `classify_frg_pack_tick` (and `frg-pack-helpers.sh`) fail-closes
  on `latest.json` `pass: false` **before** `awaiting_frg_attestation` /
  unsigned-eligible `attest`. Living `tugboat-thin-ship` currently encodes
  that order: any `pass: false` before success status is pack-fail.
  Unit tests assert `awaiting` + `{ pass: false }` is `fail`.
- #1133 added the attestor child and uncredentialed prepare. It does not
  cover unsigned `pass: false`. In-engine `classifyCandidatePrepareTick`
  already maps `awaiting_frg_attestation` to `attest` and does not read
  `latest.json` first. Prepare `failed` still fails that path.

**Conflict (do not average):** #1039 / #1133 pack-fail law treats any
`latest.json` `pass: false` as pack-fail, including
`awaiting_frg_attestation` paired with `pass: false`. Issue #1147 says
`pass: false` caused only by omitted HMAC SHALL NOT be pack-fail. This
change supersedes the any-`pass: false`-first clause for omitted HMAC
only. Real ineligible scoreboards stay pack-fail. Unsigned MUST NOT
become `pass: true`.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is Tugboat `Ship milestone v1.39.5` after
   pack loop `loop-c6abf57f55524c81` completed: prepare scored without
   KEY, wrote `latest.json` `pass: false` with the omitted-attestation
   note, returned `frg_not_eligible`, and classify printed `fail` at
   attempt 12. A later attestor produced `pass: true` on `a949c581`.
   The class is: unsigned-but-structurally-eligible FRG evidence (HMAC
   omitted because prepare is uncredentialed) is treated as ineligible
   / pack-fail instead of `awaiting_frg_attestation` plus attestor child.
2. **Shared surfaces.** Prepare public JSON status
   (`release-sub-command`). Structural vs attested pass
   (`factory-reliability-gate`). Pack-tick classify in Tugboat and
   `frg-pack-helpers.sh` (`tugboat-thin-ship`,
   `supervisor-ship-playbook`). In-engine `pipeline ship`
   (`ship-coordinator`) applies the same class when prepare would
   return `failed` for omitted HMAC. No new human-authority class:
   omitted-HMAC unsigned wait is an engine compose defect, not
   `needs-human`.
3. **Next identical fault.** The next `Ship milestone` after a terminal
   eligible pack returns `awaiting_frg_attestation`, classify emits
   `attest`, and the attestor child writes bound `pass: true`. Tests
   fail if unsigned eligible `pass: false` is classified `fail`, or if
   prepare reports `failed` for omitted HMAC only. No new mole issue.

## Goals / Non-Goals

**Goals:**

- Prepare returns `awaiting_frg_attestation` when HMAC is the only
  missing piece.
- Classify emits `attest` for unsigned eligible `pass: false`.
- Keep unsigned `pass: false` honest (no invented `pass: true`).
- Keep Tugboat a thin composer of existing CLI verbs.
- Same class on Tugboat, playbook helpers, and in-engine ship.

**Non-Goals:**

- `--skip-frg` as the ship path.
- Committing `.agent-pipeline/frg/` (gitignored).
- Persisting the key body in `state.json`.
- Changing prepare's refuse of attestor env.
- A second pack runner, grant factory, or HMAC implementation.
- Parsing free-form `notes` as the classifier source of truth.

## Decisions

### 1. Structural eligibility is independent of attested `pass`

**Choice:** Release-eligibility with HMAC optional SHALL ignore the
attested `pass` bit when HMAC is absent. Scoreboard, composition,
required scenarios, pack id, and provenance still apply. Attested
`pass: true` still requires HMAC. `latest.json` MAY remain
`pass: false` while unsigned.

**Why:** Mint already computes structural pass, then AND-gates HMAC.
Prepare currently feeds `scored.pass` (false) into the structural
check, so omitted HMAC looks like `frg_not_eligible`.

**Rejected:** Flipping unsigned `latest.json` to `pass: true`. That
breaks #757 and the tag/promote HMAC checker.

**Rejected:** Treating every `pass: false` as attest. Real ineligible
scoreboards must still fail closed.

### 2. Prepare status is `awaiting_frg_attestation`, not `failed`

**Choice:** When the bound pack is terminal, structural eligibility
holds, and HMAC is absent, prepare SHALL return
`status: "awaiting_frg_attestation"` with closed unsigned artifact
identities and the bound `loop_run_id`. It SHALL NOT persist a
`failed` / `frg_not_eligible` checkpoint for that case.

**Why:** Living prepare protocol already names this status. Tugboat
and in-engine ship already know `attest` for it. The v1.39.5 site
failed because prepare never emitted it.

**Rejected:** Keep `failed` and teach classify to recover. That leaves
in-engine ship failing on exit code 1, and it fights the existing
awaiting protocol.

### 3. Classify does not fail-close on omitted-HMAC `pass: false`

**Choice:** Shared `classify_frg_pack_tick` SHALL check bound
`pass: true` first, then `awaiting_frg_attestation` / unsigned eligible
artifacts (including when `latest.json` `pass` is false), then real
ineligible `pass: false` / prepare `failed`. Omitted HMAC means HMAC
fields are absent and structural eligibility holds. Classify SHALL
NOT use free-form `notes` as the authority.

**Why:** Today's first line `if pass_v is False: fail` never reaches
`attest`. Reorder plus omitted-HMAC discriminator matches #1147
without claiming unsigned pass.

**Rejected:** Parse the omitted-attestation note string. Lessons and
FRG law require typed fields for policy lineage, not prose markers.

Helpers in `tugboat.sh` and `frg-pack-helpers.sh` SHALL stay in sync.

### 4. In-engine ship uses the same class

**Choice:** After prepare returns awaiting, existing
`classifyCandidatePrepareTick` already attests. The prepare status
fix is the in-engine class fix. Tests SHALL still fail if prepare
reports `failed` for omitted HMAC only, so a later in-engine ship
does not need a mole.

**Rejected:** Expanding ship-adapter to re-parse `latest.json` in this
change. Not required once prepare status is honest.

## Risks / Trade-offs

- [Risk] A real ineligible `pass: false` is misread as omitted HMAC
  → Mitigation: omitted HMAC requires HMAC absent **and** structural
  eligibility. Composition missing, required scenario fail, wrong pack,
  and engine-class over threshold stay `frg_not_eligible` / classify
  `fail`. Tests cover both fixtures.
- [Risk] Hosts or tests still assert `awaiting` + `pass: false` is
  `fail` → Mitigation: **BREAKING** those tests. Invert them. Pack-done
  still requires bound `pass: true`.
- [Risk] Stale `failed` checkpoint from the v1.39.5 site blocks resume
  → Mitigation: prepare re-observe of a terminal structurally eligible
  pack with omitted HMAC SHALL return awaiting, not replay the failed
  checkpoint.
- [Trade-off] Unsigned `latest.json` stays `pass: false` until the
  attestor child. Operators reading the file without classify will see
  false. That is honest. Classify and prepare status are the tick
  contract.

## Migration Plan

- Ship the prepare status mapping and classify reorder in one change.
- Invert the `awaiting` + `{ pass: false }` → `fail` unit assertion.
- Keep existing fail fixtures for real ineligible scores.
- No data migration. On-disk unsigned `latest.json` remains valid
  attestor input.
- Rollback: revert the change. Old classify fail-closes again.

## Open Questions

None. Discriminator, status mapping, and classify order are decided.
