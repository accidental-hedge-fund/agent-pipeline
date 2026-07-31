## 1. Shared material filter

- [x] 1.1 Inventory real advance and loop `events.jsonl` kind field names from engine writers (do not invent field shapes)
- [x] 1.2 Implement a pure shared material-filter module/script (stdin or file → material one-liners) covering advance and loop allow-lists and spam suppression (CI partial/skipped, first waiting per stretch, polling bursts)
- [x] 1.3 Add unit tests with fixture JSONL lines proving allow, suppress, and first-waiting rules (tests fail without the filter logic)
- [x] 1.4 Export a single-source kind list/constant usable by filter code and drift-guards

## 2. Host skill packaging (§4 / §4b + host map)

- [x] 2.1 Add explicit host notify map to `hosts/claude/SKILL.md` (Monitor + `PushNotification` as Claude map entry; material filter composition; host-parameterized mandatory notify step)
- [x] 2.2 Update `hosts/codex/SKILL.md` §4 / §4b to reference host map + shared material filter; ensure no Claude-only tool hard-requires
- [x] 2.3 Add Grok path: first-class `hosts/grok/SKILL.md` if install supports it (#731), otherwise Grok substitute on the path Grok loads — `monitor` + material filter, no `PushNotification` hard-require
- [x] 2.4 Align dual-follow material kinds and suppression with the shared filter; keep dual-follow mandatory after linkage; apply material filter to both streams
- [x] 2.5 Document re-arm until `run_complete` / `loop_run_stopped` and cross-link #725 and #611 (do not claim this change replaces them)
- [x] 2.6 Regenerate `plugin/` mirror via `node scripts/build.mjs` when host packaging / core scripts change; commit mirror with the same change

## 3. Optional engine UX (if cheap; not required if skill-side only)

- [x] 3.1 Decide at implement time whether to add `pipeline logs … --events [--follow] --material` (and loop logs parity) reusing the pure filter
  - **Decision:** skill-side filter only (`material-filter.ts` CLI + host skill pipe examples). Engine `--material` deferred; unfiltered `logs … --events` remains default.
- [x] 3.2 If implemented, add unit tests for material follow defaults and read-only classification; update CLI help/one-liners
  - N/A (engine flag not implemented; skill-side path unit-tested via `material-filter.test.ts`)

## 4. Drift-guards and living-spec alignment

- [x] 4.1 Add CI-covered drift-guard: Grok-consumed path must not hard-require `PushNotification` without a Grok substitute
- [x] 4.2 Add CI-covered drift-guard: host skill material kind lists stay aligned with the shared filter constant
- [x] 4.3 Add/keep guard that Claude host still documents a material notify map entry
- [x] 4.4 Confirm delta specs under this change still match implemented packaging (no silent MODIFIED partials)

## 5. Verification

- [x] 5.1 Run targeted unit tests for the material filter and drift-guards
- [x] 5.2 Run `openspec validate host-neutral-progress-notify` (and `openspec validate --all` as needed)
- [x] 5.3 Run `npm run ci` from repo root and fix failures until green
- [x] 5.4 Smoke-check skill examples: material-filtered follow command composition for Claude, Codex, and Grok paths
