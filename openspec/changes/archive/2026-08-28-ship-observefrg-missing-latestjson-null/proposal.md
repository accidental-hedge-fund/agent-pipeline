## Why

After #1270, `pipeline ship --milestone v1.39.14` can prove the merged train, then exits 1 instead of starting Factory Reliability Gate (FRG) pack / `factory-release prepare`. `observeFrg` reuses the tag-path validator and catches only the substring `"evidence missing"`. The tag-path formatter now throws `missing at ${latestPath}` inside `formatFrgTagPathFailure`. Absent `latest.json` is the normal pre-pack state. Treating it as a tag-path throw leaves `next_action` at `train_merge` with `train: null` and `frg_pack: null`. Live: 2026-08-27, engine `origin/main` @ `ebfdb357`, attestor key present, durable ship `ship-d410075efc4cf29da72f49e8`.

## What Changes

- Ship FRG **observation** SHALL treat missing, unreadable, or not-yet-release-eligible `.agent-pipeline/frg/<X.Y.Z>/latest.json` as **not observed** (`null`). The coordinator SHALL then run FRG pack / `factory-release prepare`. It SHALL NOT throw the tag-path fail-closed message during observe.
- Tag / `release ensure-tag` / publication SHALL keep fail-closed on the same missing or ineligible file via `formatFrgTagPathFailure`. Observation returning null SHALL NOT skip tagging later.
- Observe-path classification SHALL NOT depend on matching tag-path formatter copy (including the stale substring `"evidence missing"`). The next formatter rewrite SHALL NOT recreate this mole.
- Candidate-identity defects during observe (base advanced, recorded train no longer contained, HMAC candidate mismatch after a valid read) SHALL still fail closed.

## Acceptance criteria

- [ ] With train evidence proven and `.agent-pipeline/frg/<X.Y.Z>/latest.json` absent (ENOENT), `observeFrg` returns `null`. Coordinator `next_action` is `frg_pack` (factory-release prepare). Ship does not throw `formatFrgTagPathFailure` / `Cannot create or push tag`.
- [ ] Unreadable `latest.json` or a present but not-release-eligible artifact (`pass: false`, unparsable, HMAC fail) during **observe** also returns `null` so pack can run. The same artifact on **ensure-tag / publication** still fail-closes with `formatFrgTagPathFailure` and does not create or push `v<X.Y.Z>`.
- [ ] A later observe after pack writes a release-eligible `latest.json` returns that evidence. Publication / ensure-tag still validate it fail-closed; observe-null on an earlier tick does not skip the tag phase.
- [ ] Observe-path tests fail if classification matches the literal `"evidence missing"` (or any other tag-path formatter substring) as the only not-observed signal, unless that string is still the dedicated observe-path message.
- [ ] Candidate-identity failures during observe (base moved, train not contained, HMAC `candidate_git_sha` mismatch after a valid eligible read) still throw. They do not become `null`.
- [ ] Unit tests inject I/O; they do not use real network, git, or subprocess. After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This splits observe vs tag on existing ship FRG evidence. -->

### Modified Capabilities

- `ship-coordinator`: `observeFrg` SHALL return `null` when on-disk `latest.json` is absent, unreadable, or not release-eligible. After proven train evidence, coordinator `next_action` SHALL be `frg_pack`. Observe SHALL NOT throw the tag-path fail-closed message. Ensure-tag / publication SHALL still fail closed on the same file. Identity defects SHALL still throw.
- `factory-reliability-gate`: The shared tag-path validator (`validateFrgEvidenceFileForTag` / `formatFrgTagPathFailure`) SHALL stay fail-closed for tag create/push. Observe-path consumers SHALL map missing / unreadable / not-release-eligible to not-observed without treating tag-path formatter prose as the observe API. Callers SHALL NOT invent a second tag eligibility definition.

## Impact

- `core/scripts/stages/ship-adapter.ts` — `observeFrg` (and any extracted observe helper). Reconcile / `converge` already treat `null` as “run pack.”
- `core/scripts/factory-reliability-gate.ts` — keep tag-path fail-closed; optional typed observe mapping that reuses the same validator without substring-matching formatter copy.
- `core/test/ship-adapter.test.ts` — injected-dep regressions for ENOENT / unreadable / not-eligible observe-null, identity throw, and ensure-tag still fail-closed. Existing `#1269` coordinator test stubs `observeFrg → null` and does not cover the real catch.
- Existing `validateFrgEvidenceFileForTag` tests in `core/test/factory-reliability-gate.test.ts` stay fail-closed for the tag path.
- Generated `plugin/` mirror after any `core/` edit.
- No `auto_merge` config, no merge inside advance/loop, no `--skip-frg` restore, no hand-running FRG around a thrown observe. Do not finish v1.39.14 by bypassing pack.
