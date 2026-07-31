## Why

`pipeline release <version>` aborts when `ROADMAP.md` has no unshipped `| **vX.Y.Z** |` release-plan row, even when the GitHub milestone exists and all ready-to-deploy work is already merged. Cutting **v1.29.0** failed this way and forced a hand-authored plan-row PR (#727) before release could run. Maintainers should not need a separate docs PR solely to satisfy an anchor that release itself can scaffold from version, theme, and shipped-work signals.

## What Changes

- **Auto-scaffold missing unshipped plan row (primary path):** When no unshipped `| **v{version}** |` row exists in the release-plan table, `pipeline release` inserts a scaffolded row **before** other ROADMAP mutations (intro ship clause, ship-mark, shipped block, per-issue stamp), then proceeds. Theme comes from an optional CLI flag, else milestone title when available, else a documented placeholder; issue refs come from milestone membership and/or git-log-derived shipped work already used by release.
- **Never overwrite shipped rows:** An already-present `| **v{version}** ✅ shipped |` row is left unchanged; release remains idempotent for re-runs against a shipped marker.
- **Fail closed only when scaffolding is impossible:** If the release-plan table or its insert sentinel (e.g. `| *(none)* |`) is missing so a row cannot be placed safely, release aborts **before** any version bump with a structured, doctor-grade error that names the file, the expected row shape, a copy-pasteable row, and the insert location.
- **Document the required plan-row shape** in release help / host SKILL text, single-sourced with the shape enforced by `patchReleasePlanRow` / insert helpers (same column layout operators see in ROADMAP).
- **Regression coverage** for the missing-row path (insert succeeds; shipped row is not overwritten; impossible-insert fails with remediation) that bites on current abort-only behavior until the fix lands.
- **No change** to auto-merge, tag creation ownership, or inventing a version without a version argument.

## Acceptance Criteria

- [ ] Running `pipeline release <version>` (or the in-memory scaffold/pre-validate path it uses) when `ROADMAP.md` has **no** `| **v{version}** |` release-plan row inserts a scaffolded unshipped row and continues release preparation instead of aborting with only `ROADMAP anchor not found: release-plan-row`.
- [ ] The scaffolded row matches the documented column shape used by `patchReleasePlanRow` (Release / Bump / Theme / Issues / Why), with version `v{version}` and an unshipped status (no `✅ shipped` until the normal ship-mark step).
- [ ] Theme on the scaffolded row is taken from `--theme` when provided; otherwise from a matching GitHub milestone title when one is available; otherwise a documented placeholder (not silent empty).
- [ ] Issue references on the scaffolded row are derived from milestone issues and/or the same git-log / shipped-PR discovery release already uses — not left inventing issue numbers from thin air.
- [ ] An existing `| **v{version}** ✅ shipped |` row is never overwritten or re-inserted as unshipped.
- [ ] If the plan row cannot be inserted (missing release-plan table or insert sentinel), release exits non-zero **before** version bump / package writes, printing a copy-pasteable row, the expected path (`ROADMAP.md`), and where to insert it.
- [ ] Release help and host SKILL document the required plan-row shape in language that matches the insert/`patchReleasePlanRow` contract (single conceptual source — no contradictory shapes).
- [ ] Unit/regression tests cover: missing unshipped row → insert then ship-mark; already-shipped row → unchanged; impossible insert → structured remediation error; at least one test fails against pre-fix abort-only behavior (bite proof).
- [ ] No auto-merge path and no version invention without a version/alias argument.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `release-sub-command`: Replace hard-abort-on-missing-plan-row with ensure-or-scaffold-before-mutate; document plan-row shape; keep fail-closed remediation when scaffolding is impossible; never overwrite shipped rows.

## Impact

- **Code:** `core/scripts/stages/release.ts` (`patchReleasePlanRow`, `scaffoldRoadmap`, pre-validate / dry-run / live orchestration, optional `--theme`, theme/issue sourcing for insert). Reuse existing `insertReleasePlanRow` shape where it already matches intake/sweep.
- **Tests:** `core/test/release.test.ts` (and any help/docs drift guards if present).
- **Docs:** release help text / `hosts/*/SKILL.md` (and generated `plugin/` mirror only if SKILL packaging requires it after host edit — regenerate via `build.mjs` when implementation lands).
- **Specs:** living `openspec/specs/release-sub-command` — the scenario “Missing release-plan row aborts” becomes ensure-or-scaffold (behavioral change for operators who relied on hard fail; they get auto-insert + editor review instead).
- **Out of scope:** inventing semver without a version argument; auto-merging the release PR; rewriting historical ROADMAP rows; full doctor redesign (optional future: version-aware `release --check` can share the same ensure helper).
