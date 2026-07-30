## Why

After `loop_item_advance_linked` publishes an item’s advance run, mid-item stage
progress (planning → implement → review → pre-merge) lives on the **advance**
`events.jsonl`, not the sparse loop stream. Host skill §4b.d currently marks
following that advance stream as **optional**, so harnesses that only tail loop
events see long silence until a terminal loop outcome. Dogfood on #554 required a
session-local dual-follow workaround. Until #611 (and dense pre-merge mirror
#682) make the loop stream sufficient for stage progress, dual-follow after
linkage is the only complete operator progress path and must be mandatory in the
orchestration contract.

## What Changes

- **BREAKING (docs/contract only):** Host skill orchestration for
  `/pipeline:loop` drive/resume **SHALL** arm a follow on the linked advance
  `events` path when `loop_item_advance_linked` (or equivalent linkage) publishes
  `pipeline_run_id` / `events` — no longer “optionally.”
- Update ordered protocol step 4 in living `loop-skill-orchestration` and in
  `hosts/claude/SKILL.md` / `hosts/codex/SKILL.md` §4b.d (and plugin skill
  mirror) to mandatory dual-follow with follow-switch rules on item finish / new
  item link.
- Document material **advance** event kinds to surface (same spirit as single-
  issue §4): `stage_start`, `stage_complete`, `pr_created`, `review_verdict`,
  `gate_result`, `blocker_set`, `run_complete` (suppress pure CI poll spam).
- Document that loop-only follow remains valid for schedule/hold/terminal loop
  kinds but is **insufficient alone** for mid-item stage progress until #611.
- Cross-link #611 and #682; note that when #611 ships first-class stage progress
  on the loop stream, this dual-follow requirement MAY be demoted to optional /
  recommended full-fidelity in that PR.
- Add a cheap drift-guard (skill/prose test) if practical so “optionally follow
  active item advance” cannot regress without CI failing.
- Regenerate `plugin/` when host skill sources change (same-change mirror rule).

## Acceptance criteria

- [ ] `hosts/claude/SKILL.md` §4b.d (or successor) uses **SHALL/must** language
      for arming an advance-events follow after `loop_item_advance_linked` /
      equivalent linkage publishes `pipeline_run_id` or absolute `events` path —
      not “optionally.”
- [ ] `hosts/codex/SKILL.md` carries the same mandatory dual-follow contract
      (Codex-appropriate tooling names).
- [ ] Skill text prefers `pipeline logs <advance-run-id> --events --follow` when
      available and accepts the absolute `events` path from the linkage event as
      a valid follow target.
- [ ] Skill text documents switching or adding follow for a new advance run on
      item finish / new item link, and stopping the previous item’s advance follow
      on terminal advance outcome.
- [ ] Material advance kinds listed for operator surface include at least
      `stage_start`, `stage_complete`, `pr_created`, `review_verdict`,
      `gate_result`, `blocker_set`, and `run_complete`, with CI-poll spam suppressed.
- [ ] Skill text states loop-only follow is insufficient for mid-item stage
      progress until #611, while remaining valid for schedule/hold/terminal loop
      kinds; cross-links #611 and #682.
- [ ] Living OpenSpec requirement for loop orchestration no longer says
      “optionally follow” for post-linkage advance streams; scenarios encode
      mandatory dual-follow after linkage and non-requirement before linkage.
- [ ] Drift guard (or equivalent cheap assertion in `npm run ci`) fails if
      mandatory dual-follow wording regresses to pure “optionally follow active
      item advance” without a documented #611 demotion path.
- [ ] `plugin/` skill mirror is regenerated in the same change when host sources
      change; `openspec validate` and `npm run ci` pass.

## Capabilities

### New Capabilities

_(none — this tightens an existing host-orchestration contract)_

### Modified Capabilities

- `loop-skill-orchestration`: post-linkage advance-event follow becomes
  mandatory (dual-follow); material advance kinds and loop-only insufficiency /
  #611 demotion path are specified; optional-before-linkage remains.

## Impact

- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` — §4b.d dual-follow wording and
  material advance kinds / cross-links.
- `plugin/pipeline/skills/pipeline/SKILL.md` (and any Codex host projection) —
  regenerated mirror of host skill sources.
- `openspec/specs/loop-skill-orchestration/spec.md` — requirement text and
  scenarios for ordered protocol step 4.
- `core/test/*` — optional/cheap drift-guard asserting skill (or packaged skill)
  no longer presents post-linkage advance follow as merely optional.
- **Not impacted:** loop supervisor emit behavior (#611/#682), advance engine
  stages, logs CLI implementation, auto-merge, or runtime loop scheduling.
- **Operators:** harnesses that previously loop-only-followed will be instructed
  to dual-follow after linkage (docs/contract change; no engine API break).
