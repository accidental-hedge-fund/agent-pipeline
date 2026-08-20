## Context

See `proposal.md` for why. Current law and code:

- Living `tugboat-thin-ship` already requires the attestor child to inherit
  `PIPELINE_FRG_ATTESTATION_KEY` when set, and when the supervisor supplied
  only `PIPELINE_FRG_ATTESTATION_KEY_FILE`, present that file as `KEY` in
  the attestor child only (#1133).
- `invoke_frg_pack_attestor` in `examples/supervisor/shell/tugboat.sh`
  implements that recipe: inherit `KEY` + `env -u KEY_FILE`; else fail
  `missing_attestor_credential` / `unreadable_attestor_key_file`; else
  `KEY="$(cat -- "$KEY_FILE")"` + `env -u KEY_FILE`.
- Living ensure-tag law requires argv (`version`, `mergeCommitOid`,
  `--packed-candidate`, `--repo-path`) and fail-closed missing merge OID.
  It does not require credential mapping. `invoke_release_ensure_tag`
  spawns `"${SHIP_END_CLI[@]}" release ensure-tag …` with inherited env.
- Candidate `release ensure-tag` HMAC verify requires
  `PIPELINE_FRG_ATTESTATION_KEY`. It does not load `KEY_FILE`. Factory-gate
  is the same: the attestor maps the file because the engine reads `KEY`.
- Site: ship v1.39.6 `ensure-tag.err` at `2026-08-20T17:38:32Z`. Attestor
  for that ship succeeded.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is `invoke_release_ensure_tag` on v1.39.6
   after a successful attestor. The class is: every Tugboat child that
   verifies FRG HMAC must present `KEY_FILE` as `KEY` with the attestor
   recipe. A path-local env wrap around one ship is not the class fix.
2. **Shared surfaces.** Credential recipe lives in `tugboat-thin-ship`
   for both HMAC-verify children. Implementation copies the attestor
   branches into ensure-tag. `frg-pack-helpers.sh` stays untouched unless
   that helper is later shared; ensure-tag is tugboat-only. No new
   human-authority class: missing supervisor `KEY`/`KEY_FILE` is a
   compose/config defect, not `needs-human`.
3. **Next identical fault.** A later HMAC-verify child that inherits
   only `KEY_FILE` still fails the living spec and the sibling extract
   test (attestor + ensure-tag from `tugboat.sh`). No new mole issue for
   the same mapping miss on those two children. A third HMAC-verify
   child SHALL use this same recipe; that is the class rule.

## Goals / Non-Goals

**Goals:**

- Ensure-tag child presents the producer credential with the attestor
  recipe.
- Fail closed with a named stderr reason when the credential is missing,
  unreadable, or empty, before spawning `release ensure-tag`.
- Regression test extracts both HMAC-verify helpers from `tugboat.sh`
  and fails on the 1.39.6 neither-KEY-nor-KEY_FILE child.

**Non-Goals:**

- Teaching `release ensure-tag` to load `KEY_FILE` (second key loader).
- Changing HMAC, inventing FRG JSON, or committing gitignored
  `latest.json`.
- A hand `env KEY=…` wrap around Tugboat.
- Unsetting `KEY`/`KEY_FILE` in the Tugboat parent.
- Sharing ensure-tag through `frg-pack-helpers.sh`.
- `--skip-frg` as the ship path.

## Decisions

### 1. Copy the attestor recipe into ensure-tag; do not add a second key loader

**Choice:** `invoke_release_ensure_tag` SHALL apply the same five-branch
recipe as `invoke_frg_pack_attestor` before the existing
`"${SHIP_END_CLI[@]}" release ensure-tag …` spawn. Keep argv
(`version`, merge OID, `--packed-candidate`, `--repo-path`) unchanged.
Do not change the engine to read `KEY_FILE`.

**Why:** Factory-gate and `release ensure-tag` both verify HMAC from
`PIPELINE_FRG_ATTESTATION_KEY`. The attestor already maps the file.
A second loader in the engine would create two presentation paths and
would not remove the composer duty to `env -u KEY_FILE` in the child.

**Alternatives considered:**

- Teach `release ensure-tag` to read `KEY_FILE` → rejected; class is
  composer presentation, matching attestor. Engine stays one loader.
- Extract a shared `present_frg_attestation_key` helper in this change
  → deferred. Issue says copy the recipe. Attestor also exists in
  `frg-pack-helpers.sh`, so a tugboat-only extract would not unify both
  copies. Sibling tests catch drift on the two `tugboat.sh` children.
  A later extract is allowed if copy would immediately diverge.
- Human `env KEY=…` around Tugboat → rejected; not the product path.
  Train then re-exec of candidate tugboat is the chicken-egg path.

### 2. Named fail-closed reasons match the attestor tokens

**Choice:** When `KEY` is unset: empty or missing `KEY_FILE` prints
`missing_attestor_credential`; unreadable file prints
`unreadable_attestor_key_file`; empty file (`! -s`) prints
`missing_attestor_credential`. Ensure-tag keeps writing those tokens to
stderr (`>&2`). `ship_one` already redirects stderr to
`ensure-tag.err`. Do not add an `$err` file argument.

**Why:** Same tokens as attestor. Operator grep and unit assertions stay
one vocabulary. Existing ensure-tag I/O is stderr, not an err-path
parameter.

**Alternatives considered:**

- Distinct ensure-tag tokens (`missing_ensure_tag_credential`) →
  rejected; class is one credential recipe, not two reason sets.
- Fail by letting HMAC verify print
  `PIPELINE_FRG_ATTESTATION_KEY is required…` → rejected; that is the
  1.39.6 site. Fail before spawn.

### 3. Regression extracts both helpers from tugboat.sh

**Choice:** Add a co-located test in `core/test/tugboat.test.ts` that
extracts `invoke_release_ensure_tag` and `invoke_frg_pack_attestor` via
`extractNamedFn` from `examples/supervisor/shell/tugboat.sh`. Reuse
`writeFakePipeline`. Fixture: `KEY` unset, `KEY_FILE` a readable
non-empty dummy file, valid finish JSON and `SHIP_END_*`. Assert child
env `KEY=<dummy body>` and `KEY_FILE_UNSET`. Fail if the ensure-tag
child records neither `KEY` nor `KEY_FILE`. Keep existing argv /
missing-OID tests.

**Why:** The #1133 attestor test extracts from `frg-pack-helpers.sh`.
Ensure-tag is tugboat-only. Extracting both HMAC children from
`tugboat.sh` binds the class in the file that ships.

**Alternatives considered:**

- Source assertion only (`assert.match(fn, /PIPELINE_FRG_ATTESTATION_KEY/`)
  → rejected; the 1.39.6 helper has neither mapping. Env recording is
  the bite.
- Change the existing #1133 attestor test to extract from `tugboat.sh`
  → out of scope; that test still guards the helper copy.

### 4. Do not persist the key body; do not unset parent env

**Choice:** `cat` of `KEY_FILE` is only the ensure-tag child env
assignment. Do not write `KEY` / `KEY_FILE` contents into `state.json`,
finish JSON, request JSON, or ship logs. Do not `unset` those names in
the Tugboat parent.

**Why:** Same isolation as attestor. Parent must keep `KEY_FILE` for a
later HMAC child. Prepare remains uncredentialed.

## Risks / Trade-offs

- **[Risk] `cat` of a huge or binary KEY_FILE blows env.** → Mitigation:
  attestor already uses this recipe; supervisor `KEY_FILE` is a small
  HMAC secret. Do not add a new size gate in this change.
- **[Risk] Child env leaks KEY into `ensure-tag.out` / `.err` if the
  CLI echoes env.** → Mitigation: existing engine HMAC path does not
  print the key. Tests already forbid persisting the key body into pack
  files for attestor; ensure-tag test SHALL NOT write the dummy body
  into finish JSON or state.
- **[Risk] Stale installed `~/.local/bin/tugboat` keeps the 1.39.6
  helper.** → Mitigation: after train-complete, Tugboat re-execs
  candidate `tugboat.sh`. That is the intended chicken-egg path. Do not
  add a human KEY wrap.
- **[Trade-off] Recipe is copied, not extracted.** Drift is possible
  between attestor and ensure-tag. Sibling extract test plus living spec
  are the drift gate. A shared helper MAY land later without changing
  this behavior.

## Migration Plan

1. Land composer helper + unit test on this branch. No engine schema
   change.
2. Merge. Next `Ship milestone` trains, re-execs candidate tugboat, then
   FRG pack (attestor already maps KEY_FILE) and ensure-tag (this
   mapping).
3. A ship already stuck at 1.39.6 ensure-tag does not need a human KEY
   wrap. Re-run from candidate tugboat after this SHA is the packed
   candidate (train then re-exec).

Rollback: revert the composer/test/spec change. Ensure-tag would again
spawn with neither `KEY` nor presented `KEY_FILE`. That is the defect.

## Open Questions

None. Fail-reason tokens MAY be the attestor names or documented
equivalents; specs name the attestor tokens as the required class.
