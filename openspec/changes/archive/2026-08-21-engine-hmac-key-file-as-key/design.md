## Context

See `proposal.md` for why. Current law and code:

- Living `tugboat-thin-ship` requires Tugboat HMAC-verify children (`invoke_frg_pack_attestor` and `invoke_release_ensure_tag`) to present `PIPELINE_FRG_ATTESTATION_KEY_FILE` as `PIPELINE_FRG_ATTESTATION_KEY` (#1133, #1174). Recipe: inherit `KEY` + unset `KEY_FILE`; else fail closed on missing/empty/unreadable `KEY_FILE`; else `KEY="$(cat -- "$KEY_FILE")"` + unset `KEY_FILE`.
- Archived #1174 design rejected teaching `release ensure-tag` to read `KEY_FILE`. Disposition: composer presentation, engine stays one MAC loader. That is Tugboat-scoped. Claude Code and Hermes exec `pipeline ship` / `factory-gate` / `ensure-tag` without that wrap.
- Engine HMAC mint/verify still reads `PIPELINE_FRG_ATTESTATION_KEY` only (`FRG_ATTESTATION_KEY_ENV`). Error when missing: `PIPELINE_FRG_ATTESTATION_KEY is required to verify integrity.attestation`.
- In-engine `attestorChildEnv` unsets `KEY_FILE` and does not load the file. Default ensure-tag spawn in `ship-adapter.ts` uses `uncredentialedPrepareEnv`, which deletes both `KEY` and `KEY_FILE`. Prepare correctly uses `uncredentialedPrepareEnv`.
- GitHub `auto-tag-release.yml` uses repo secret `KEY`. Hosts keep a file.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is in-engine `pipeline ship` attestor/ensure-tag env on a host that has only `KEY_FILE` (same HMAC miss as v1.39.6 ensure-tag). The class is: every engine HMAC-verify entry presents `KEY_FILE` as `KEY` with the Tugboat recipe. A Tugboat-only wrap is host-unequal and is not the class fix.
2. **Shared surfaces.** One engine presentation helper. Callers: `factory-gate --from-run`, `release ensure-tag`, in-engine `pipeline ship` attestor spawn, in-engine `pipeline ship` ensure-tag spawn. HMAC mint/verify still authenticates with `KEY` after presentation. Prepare stays uncredentialed. No new human-authority class: missing host `KEY`/`KEY_FILE` is a compose/config defect, not `needs-human`.
3. **Next identical fault.** A later Claude Code or Hermes run with only `KEY_FILE` still fails the living spec and the child-env regression if attestor or ensure-tag has neither `KEY` nor `KEY_FILE`. No new mole issue for the same mapping miss on those engine children.

This change **reverses** the #1174 “engine must not load `KEY_FILE`” disposition for host equality. It does not reverse HMAC, uncredentialed prepare, or Tugboat’s existing wrap.

## Goals / Non-Goals

**Goals:**

- One engine recipe presents `KEY_FILE` as `KEY` for HMAC-verify children.
- Direct `factory-gate --from-run` and `release ensure-tag` work with only `KEY_FILE`.
- In-engine `pipeline ship` attestor and ensure-tag child env record `KEY=<file body>` and `KEY_FILE` unset.
- Fail closed with named reasons before HMAC verify when the credential is missing, empty, or unreadable.
- Regression test fails on the current neither-KEY-nor-KEY_FILE child env.

**Non-Goals:**

- A second HMAC MAC loader that verifies with `KEY_FILE` directly.
- Dropping HMAC or tagging unsigned `pass: true`.
- Changing GitHub Actions to read `KEY_FILE`.
- Removing the Tugboat wrap (defense in depth).
- Putting the key body in SKILL.md or ship state.
- `--skip-frg`, human `git tag` / `gh release create`, a second pin file.

## Decisions

### 1. Shared engine helper at composer spawn and HMAC-verify CLI entry

**Choice:** Add one engine helper that implements the Tugboat five-branch recipe against a parent env copy. In-engine `pipeline ship` uses it when spawning attestor and ensure-tag children. `factory-gate --from-run` and `release ensure-tag` apply the same helper before HMAC mint or verify so a host that execs those verbs with only `KEY_FILE` succeeds. HMAC mint/verify still read `PIPELINE_FRG_ATTESTATION_KEY` after presentation.

**Why:** The user story names `pipeline ship`, `factory-gate`, and `release ensure-tag`. Composer-only mapping (the #1174 pattern) leaves direct CLI hosts unequal. A second MAC loader would split verify paths. Presentation then one `KEY` loader keeps HMAC law intact.

**Alternatives considered:**

- In-engine ship composer only, engine CLIs still KEY-only → rejected; Claude Code can exec `factory-gate --from-run` / `release ensure-tag` with only `KEY_FILE`.
- Teach HMAC verify to MAC-check with `KEY_FILE` as a second loader → rejected; two verify paths. Hosts keep a file; engine loads it into `KEY`.
- Keep #1174 Tugboat-only mapping → rejected; Buzz works, Claude Code / Hermes fail. Class is engine duty.
- Pass `KEY_FILE` through to the child and let only the CLI load it → rejected as the sole fix. Current `attestorChildEnv` unsets `KEY_FILE` before spawn; current ensure-tag uses `uncredentialedPrepareEnv`. The required observable is child env `KEY=<dummy>` and `KEY_FILE` unset, matching Tugboat.

### 2. Named fail-closed reasons match the Tugboat tokens

**Choice:** When `KEY` is unset: missing or empty `KEY_FILE` (including zero-byte file) fails with `missing_attestor_credential` (or equivalent). Unreadable file fails with `unreadable_attestor_key_file` (or equivalent). Fail before spawn for in-engine children. Fail before HMAC mint/verify for direct CLI. Do not wait for `PIPELINE_FRG_ATTESTATION_KEY is required to verify integrity.attestation`.

**Why:** Same operator vocabulary as Tugboat attestor/ensure-tag. That 1.39.6 message is the site symptom, not the class reason.

**Alternatives considered:**

- Distinct engine tokens (`missing_ship_attestor_credential`) → rejected; class is one credential recipe.
- Let HMAC verify print the existing KEY-required error → rejected; that is the v1.39.6 site.

### 3. Ensure-tag MUST NOT use uncredentialedPrepareEnv; prepare MUST still use it

**Choice:** Attestor spawn and ensure-tag spawn both take the presentation helper result. Prepare (and other unsigned ship-end leaves that must not see the producer credential) keep `uncredentialedPrepareEnv`. Do not mutate parent env. Do not persist the key body in ship state, finish JSON, request JSON, or logs.

**Why:** AC3 and living FRG pack isolation. Mixing ensure-tag into the prepare env helper is the in-engine 1.39.6-class bug.

**Alternatives considered:**

- Credential all ship-end children → rejected; prepare must stay unsigned.
- Inherit parent env unchanged for ensure-tag → rejected; child would keep `KEY_FILE` set, and HMAC still would not see `KEY` unless the CLI loads it. Recipe requires `KEY_FILE` unset in the HMAC child.

### 4. Regression records child env; fail if neither KEY nor KEY_FILE

**Choice:** Unit tests inject parent env (`KEY` unset, `KEY_FILE` a readable non-empty dummy file) into the presentation helper and/or in-engine spawn env. Assert attestor and ensure-tag child env `KEY=<dummy body>` and `KEY_FILE` unset. Fail if a child records neither `KEY` nor `KEY_FILE` (current `attestorChildEnv` + `uncredentialedPrepareEnv`). Cover inherit-KEY, missing/empty `KEY_FILE`, unreadable file, empty file, and prepare still unsets both. Tests inject I/O. They SHALL NOT start a live tag, network call, git, or subprocess ship.

**Why:** Source regex would miss the current helpers (they already mention the env names while deleting them). Env recording is the bite, matching #1174.

**Alternatives considered:**

- Source assertion only (`assert.match(fn, /KEY_FILE/)`) → rejected; current helpers already name `KEY_FILE` while unsetting it.
- Live `pipeline ship --milestone` → rejected; unit tests inject deps.

### 5. Tugboat wrap stays; GitHub Actions stays KEY

**Choice:** Do not remove `invoke_frg_pack_attestor` / `invoke_release_ensure_tag` mapping. When Tugboat already set `KEY` and unset `KEY_FILE`, engine branch 1 inherits `KEY`. Do not change `auto-tag-release.yml` to read `KEY_FILE`.

**Why:** Tugboat defense in depth is compatible. Actions already has the repo secret as `KEY`. Out of scope to dual-read in CI.

## Risks / Trade-offs

- **[Risk] Reading a huge or binary `KEY_FILE` blows env.** → Mitigation: Tugboat already `cat`s the file; host `KEY_FILE` is a small HMAC secret. Do not add a new size gate in this change.
- **[Risk] Child env leaks `KEY` into ship logs if a CLI echoes env.** → Mitigation: existing HMAC path does not print the key. Tests SHALL NOT write the dummy body into ship state or finish JSON.
- **[Risk] Double presentation (Tugboat then engine) mutates a presented KEY.** → Mitigation: when `KEY` is set, inherit it and only unset `KEY_FILE`. Do not re-`cat` the file over an existing `KEY`.
- **[Risk] Applying the helper inside factory-gate also affects unsigned scoring.** → Mitigation: apply only on HMAC-verify / `--from-run` attestor paths. Prepare and unsigned scoring stay uncredentialed and still omit HMAC when both `KEY` and `KEY_FILE` are absent.
- **[Trade-off] Helper exists in engine and still in Tugboat shell.** Drift is possible. Engine living spec plus child-env tests are the class gate. Tugboat tests stay. A later extract across shell and TypeScript is allowed; this change does not require it.

## Migration Plan

1. Land helper + regression tests that fail on current child env. Then wire attestor/ensure-tag spawn and HMAC-verify CLI entry. Prepare env unchanged.
2. After any `core/` edit, regenerate `plugin/` in the same change. `npm run ci` must pass.
3. Next `pipeline ship --milestone` on Claude Code or Hermes with only `KEY_FILE` HMAC-verifies without a Tugboat wrap or a human `env KEY=…`.

Rollback: revert the helper, spawn env, CLI presentation, tests, and spec. In-engine ship with only `KEY_FILE` would again HMAC-fail. That is the defect.

## Open Questions

None. Fail-reason tokens MAY be the Tugboat names or documented equivalents; specs name those tokens as the required class.
