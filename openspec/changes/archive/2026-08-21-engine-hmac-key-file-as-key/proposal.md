## Why

Claude Code and Hermes are both hosts. `pipeline ship`, `factory-gate --from-run`, and `release ensure-tag` still read HMAC from `PIPELINE_FRG_ATTESTATION_KEY` only. Tugboat already presents `PIPELINE_FRG_ATTESTATION_KEY_FILE` as `KEY` (#1133, #1174). In-engine `pipeline ship` does not: `attestorChildEnv` unsets `KEY_FILE` without loading it, and default ensure-tag spawn uses `uncredentialedPrepareEnv`, which deletes both. A Claude Code skill that execs `pipeline ship --milestone` with only `KEY_FILE` fails HMAC the same way Tugboat ensure-tag failed on v1.39.6: `PIPELINE_FRG_ATTESTATION_KEY is required to verify integrity.attestation`. Hosts that keep a file must not depend on a Tugboat-only wrap.

## What Changes

- **Class law, not a Tugboat wrap.** Engine HMAC-verify children (`factory-gate --from-run`, `release ensure-tag`, and in-engine `pipeline ship` attestor and ensure-tag spawns) SHALL present `PIPELINE_FRG_ATTESTATION_KEY_FILE` as `PIPELINE_FRG_ATTESTATION_KEY` using the same five-branch recipe as Tugboat `invoke_frg_pack_attestor` / `invoke_release_ensure_tag`. Presentation is engine (or in-engine ship composer) duty, not Tugboat-only.
- **HMAC stays.** HMAC-SHA256 still seals gitignored `latest.json` so hand-authored `{pass: true}` cannot tag. After presentation, HMAC mint and verify still use `KEY`. GitHub `auto-tag-release.yml` still uses the repo secret `KEY`.
- **Prepare stays uncredentialed.** Unsigned `factory-release prepare` SHALL still have `KEY` and `KEY_FILE` unset in that child. Ensure-tag SHALL NOT use `uncredentialedPrepareEnv`.
- **Fail closed before HMAC verify.** Missing, empty, or unreadable `KEY_FILE` when `KEY` is unset SHALL fail closed with a named reason (`missing_attestor_credential` / `unreadable_attestor_key_file` or equivalent) and SHALL NOT spawn HMAC verify.
- **Tests bite.** A unit test SHALL fail if `KEY` is unset, `KEY_FILE` is a readable non-empty dummy file, and the ensure-tag or attestor child env has neither `KEY` nor `KEY_FILE` (the current `pipeline ship` / `uncredentialedPrepareEnv` helper). Sibling: both children record `KEY=<dummy>` and `KEY_FILE` unset.

**BREAKING** for any in-engine ship fixture that expects attestor or ensure-tag child env to inherit only `KEY_FILE` as a path, or to have both `KEY` and `KEY_FILE` unset, when the parent supplied a readable non-empty `KEY_FILE`.

This **supersedes** the #1174 disposition that KEY_FILE presentation is Tugboat-only and that the engine must not load `KEY_FILE`. Tugboat may keep its recipe as defense in depth.

Non-goals: dropping HMAC or tagging from unsigned `pass: true`; putting the key body in SKILL.md; a hand `env KEY=…` wrap as the product path; changing GitHub Actions to read `KEY_FILE`; #1048/#1049/#1050 plugin-delete / v1.40.0 packaging; a second pin file; human `git tag` / `gh release create` / `--skip-frg`.

## Acceptance criteria

- [ ] With `PIPELINE_FRG_ATTESTATION_KEY` unset and `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty file, in-engine `pipeline ship` attestor (`factory-gate --from-run`) and ensure-tag children both have `PIPELINE_FRG_ATTESTATION_KEY` equal to that file body and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset.
- [ ] When `PIPELINE_FRG_ATTESTATION_KEY` is already set, those children inherit that value and still have `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset.
- [ ] When `KEY` is unset and `KEY_FILE` is unset, empty, or names an empty file, the engine fails closed with a named reason (`missing_attestor_credential` or equivalent) and does not spawn HMAC verify.
- [ ] When `KEY` is unset and `KEY_FILE` names an unreadable file, the engine fails closed with a named reason (`unreadable_attestor_key_file` or equivalent) and does not spawn HMAC verify.
- [ ] Direct `pipeline factory-gate --from-run` and `pipeline release ensure-tag` apply the same recipe, so a host with only `KEY_FILE` can HMAC-verify without a Tugboat env wrap.
- [ ] Ensure-tag spawn does not use `uncredentialedPrepareEnv`. Prepare / unsigned `factory-release prepare` still has `KEY` and `KEY_FILE` unset in that child.
- [ ] A unit test fails if `KEY` is unset, `KEY_FILE` is a readable non-empty dummy file, and the ensure-tag or attestor child env has neither `KEY` nor `KEY_FILE`. Sibling: both children record `KEY=<dummy>` and `KEY_FILE` unset.
- [ ] Living HMAC-verify / ship-end law states KEY_FILE presentation is engine (or in-engine ship composer) duty, not Tugboat-only. Pre-merge archives this change.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends existing HMAC-verify and ship-end law. -->

### Modified Capabilities

- `factory-reliability-gate`: Engine HMAC-verify (`factory-gate --from-run` and `release ensure-tag`) SHALL present `PIPELINE_FRG_ATTESTATION_KEY_FILE` as `PIPELINE_FRG_ATTESTATION_KEY` using the Tugboat five-branch recipe before HMAC mint or verify. Missing, empty, or unreadable credential SHALL fail closed with a named reason. HMAC still requires `KEY` after presentation. Prepare remains uncredentialed.
- `ship-end-candidate-engine`: In-engine `pipeline ship` attestor and ensure-tag spawns SHALL use that same recipe. Ensure-tag SHALL NOT use `uncredentialedPrepareEnv`. Prepare SHALL still unset `KEY` and `KEY_FILE`. A regression test SHALL fail if those children have neither `KEY` nor `KEY_FILE` when the parent supplied only a readable non-empty `KEY_FILE`.

## Impact

- **Engine:** `attestorChildEnv` and ensure-tag spawn env in `core/scripts/ship-end-candidate.ts` and `core/scripts/stages/ship-adapter.ts`. Shared presentation helper used by `factory-gate --from-run`, `release ensure-tag`, and in-engine ship HMAC children. HMAC mint/verify in `core/scripts/factory-reliability-gate.ts` still authenticates with `KEY` after presentation.
- **Tests:** `core/test/ship-end-candidate.test.ts` (and ship-adapter / factory-gate / ensure-tag co-located tests as needed). Inject env and I/O. No live tag, network, git, or subprocess ship.
- **Tugboat:** Existing KEY_FILE→KEY recipe in `tugboat.sh` stays valid (child already has `KEY`). This change does not remove that wrap.
- **Depends on:** living Tugboat HMAC-verify recipe (#1133, #1174), uncredentialed prepare (#1133), candidate ensure-tag after finish (#1149).
- **Does not:** drop HMAC; authorize unsigned `pass: true` tags; put the key in SKILL.md; change Actions to read `KEY_FILE`; merge inside advance/loop; add `--skip-frg` as the ship path.
- **Evidence:** `attestorChildEnv` unsets `KEY_FILE` without `cat`; ship-adapter ensure-tag spawn at ~1825 uses `uncredentialedPrepareEnv`; 1.39.6 error `PIPELINE_FRG_ATTESTATION_KEY is required to verify integrity.attestation`; runbook still says the engine reads `KEY` only.
