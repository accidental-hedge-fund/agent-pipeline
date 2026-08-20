## Why

Ship v1.39.6 completed FRG HMAC `pass:true` and `release finish`, then Tugboat
`invoke_release_ensure_tag` failed with `PIPELINE_FRG_ATTESTATION_KEY is
required to verify integrity.attestation`. Supervisor env already sets
`PIPELINE_FRG_ATTESTATION_KEY_FILE`. The attestor child (`invoke_frg_pack_attestor`)
presents that file as `PIPELINE_FRG_ATTESTATION_KEY`. Ensure-tag does not.
HMAC verify in ensure-tag therefore ran with neither `KEY` nor `KEY_FILE`
presented as `KEY`. A human `env KEY=…` wrap is not the ship path.

## What Changes

- **Class law, not a 1.39.6 mole.** Every Tugboat child that verifies Factory
  Reliability Gate (FRG) HMAC (`invoke_frg_pack_attestor` and
  `invoke_release_ensure_tag`) SHALL present the producer credential with one
  recipe: inherit `PIPELINE_FRG_ATTESTATION_KEY` when set, else present a
  readable non-empty `PIPELINE_FRG_ATTESTATION_KEY_FILE` as `KEY`, then
  `env -u PIPELINE_FRG_ATTESTATION_KEY_FILE`. Fail closed with a named reason
  when the credential is missing, unreadable, or empty.
- **Ensure-tag child is credentialed.** After `release finish`, Tugboat
  `invoke_release_ensure_tag` SHALL spawn
  `"${SHIP_END_CLI[@]}" release ensure-tag …` with that recipe. It SHALL NOT
  leave HMAC verify without a credential when `KEY_FILE` is a readable
  non-empty file.
- **Attestor recipe stays.** `invoke_frg_pack_attestor` already implements
  this mapping. This change does not weaken prepare-child uncredentialed
  isolation.
- **Tests bite.** A co-located unit test SHALL extract both helpers from
  `examples/supervisor/shell/tugboat.sh` via `extractNamedFn`. With `KEY`
  unset and `KEY_FILE` set to a readable non-empty dummy file, a fake
  `SHIP_END_CLI` SHALL record child env `KEY=<dummy body>` and
  `KEY_FILE_UNSET`. The test SHALL fail if the ensure-tag child has neither
  `KEY` nor `KEY_FILE` in that fixture (the 1.39.6 helper).

**BREAKING** for any Tugboat fixture that expects `invoke_release_ensure_tag`
to spawn the candidate CLI with supervisor `KEY_FILE` inherited as a path
(or with neither `KEY` nor `KEY_FILE`).

Non-goals: committing gitignored `.agent-pipeline/frg/latest.json`; human
`git tag` / `gh release create`; `--skip-frg` as the ship path; raising Grok
implementer timeouts; changing HMAC algorithm or inventing FRG JSON; editing
`ledger.json` or production pin JSON by hand; a hand `env KEY=…` wrap around
Tugboat as the product path.

## Acceptance criteria

- [ ] With `PIPELINE_FRG_ATTESTATION_KEY` unset and
      `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty file,
      Tugboat `invoke_release_ensure_tag` spawns `release ensure-tag` with
      child env `PIPELINE_FRG_ATTESTATION_KEY` equal to that file body and
      `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset.
- [ ] When `PIPELINE_FRG_ATTESTATION_KEY` is already set, ensure-tag inherits
      that value and still unsets `PIPELINE_FRG_ATTESTATION_KEY_FILE` in the
      child.
- [ ] When `KEY` is unset and `KEY_FILE` is unset, empty, or names an empty
      file, ensure-tag fails closed with a named stderr reason
      (`missing_attestor_credential` or equivalent) and does not spawn
      `release ensure-tag`.
- [ ] When `KEY` is unset and `KEY_FILE` names an unreadable file, ensure-tag
      fails closed with a named stderr reason
      (`unreadable_attestor_key_file` or equivalent) and does not spawn
      `release ensure-tag`.
- [ ] Ensure-tag does not leave HMAC verify without a credential when
      `KEY_FILE` is a readable non-empty file. A unit test fails if that
      child records neither `KEY` nor `KEY_FILE` (the 1.39.6 helper).
- [ ] The credential recipe for ensure-tag matches `invoke_frg_pack_attestor`.
      The same test extracts both functions from
      `examples/supervisor/shell/tugboat.sh` via `extractNamedFn` and uses
      the same `writeFakePipeline` env recorder as the attestor `#1133` test.
- [ ] Tugboat still does not persist the key body in `state.json`, still does
      not shell `git tag` or `gh release create`, and still does not default
      `--skip-frg`.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change.
      `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends existing Tugboat ensure-tag law. -->

### Modified Capabilities

- `tugboat-thin-ship`: After `release finish`, `invoke_release_ensure_tag`
  SHALL present `PIPELINE_FRG_ATTESTATION_KEY_FILE` as
  `PIPELINE_FRG_ATTESTATION_KEY` using the same recipe as
  `invoke_frg_pack_attestor`. HMAC-verify children SHALL fail closed with a
  named reason when the credential is missing, unreadable, or empty. A
  regression test SHALL fail if the ensure-tag child has neither `KEY` nor
  `KEY_FILE` when the supervisor supplied only a readable non-empty
  `KEY_FILE`.

## Impact

- **Tugboat:** `examples/supervisor/shell/tugboat.sh` `invoke_release_ensure_tag`.
  Copy the attestor recipe. Keep `frg-pack-helpers.sh` in sync only if that
  helper is shared; ensure-tag is tugboat-only.
- **Tests:** `core/test/tugboat.test.ts`. Extract real helpers. Reuse
  `writeFakePipeline`. No live tag, network, git, or ship subprocess.
- **Engine:** `release ensure-tag` HMAC verify already requires
  `PIPELINE_FRG_ATTESTATION_KEY`. Do not add a second key loader. Do not
  invent FRG JSON.
- **Depends on:** living attestor KEY_FILE→KEY recipe (#1133), candidate
  `release ensure-tag` after finish (#1149), `--repo-path` (#1163).
- **Does not:** authorize a human env wrap; skip FRG; commit gitignored
  `latest.json`; change HMAC; merge inside advance/loop.
- **Evidence:** `~/.local/state/pipeline-supervisor/ship-v1.39.6/ensure-tag.err`
  and `playbook.log` phase `ensure-tag` at `2026-08-20T17:38:32Z`. Attestor
  for the same ship succeeded (`frg-2026-08-20T17-32-58-103Z-4a063307`).
}
