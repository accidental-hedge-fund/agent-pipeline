## Why

Advance and loop orchestration in host skill packaging hard-requires Claude Code's `PushNotification` tool for material stage/loop bubbles. That tool does not exist on Grok (and is not Codex's surface either). Grok already gets reliable stage bubbles when the agent arms a **material-filtered** host `monitor` on `events.jsonl` (proved in-session on advances such as #718 / #722), but today Grok often installs the Claude overlay and inherits Claude-only notify instructions—so agents mis-arm dual raw JSONL monitors, invent side-channel relays, or fail after wait-cancel. The failure is skill packaging and host guidance, not a missing engine event stream: `events.jsonl` is already host-agnostic. Operators need the same class of live material bubbles on Claude, Grok, and Codex without requiring a single-host tool.

## What Changes

- **Host notify map (skill overlays only).** Document a per-host progress-notify surface:
  - Claude: existing Monitor + `PushNotification` on material kinds (unchanged intent).
  - Grok: host `monitor` on advance (and loop when dual-follow) emitting **material-only** one-liners; never require `PushNotification`.
  - Codex: existing chat/status surface with an explicit "must notify" mapping; no Claude-only tool names.
- **Shared material filter.** A tiny shared filter (skill/core script and/or documented one-liner; optional engine `logs … --material` is allowed but not required if the skill-side path lands first) that reads `events.jsonl` and prints skill-material lines only:
  - Advance: `run_start`, `stage_start`/`stage_complete`, `pr_created`/`pr_updated`, `review_verdict`, `gate_result` (suppress repeated CI `partial` / openspec `skipped` spam), `blocker_set`/`blocker_cleared`, `run_complete`.
  - Loop: `loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`, `loop_item_advance_linked`/`finished`, `loop_item_stage_progress`, material `loop_item_progress`, `loop_run_stopped` (first CI `waiting` only per stretch).
- **Host-parameterized §4 / §4b.** Shared orchestration prose says "must notify via host map" rather than bare `PushNotification` where non-Claude hosts consume the same contract. Dual-follow (loop stream + linked advance stream) remains; the material filter applies to both.
- **Grok packaging path.** Either a first-class `hosts/grok` overlay (if/when install supports `--host grok`, coordinate with #731) or an explicit documented substitute so Grok agents no longer inherit Claude-only `PushNotification` as a hard requirement.
- **Drift guards.** Tests or packaging checks fail if Claude-only notify tool names reappear on a Grok-consumed path without a Grok substitute, or if material-kind lists drift from the shared filter contract.
- **Cross-links only (no replacement):** wait-cancel re-attach remains #725; denser loop stage progress remains #611 if still open.

## Acceptance criteria

- [ ] Host skill overlays document a **host notify map** for material progress: Claude = Monitor + `PushNotification`; Grok = host `monitor` with material-only one-liners (no `PushNotification`); Codex = chat/status updates with an explicit must-notify mapping and no Claude-only tool names.
- [ ] Shared material-event filter (script and/or documented one-liner, and/or optional `logs … --material`) exists and, given a mixed `events.jsonl` feed, prints only the advance and loop material kinds listed above while suppressing repeated CI `partial` / openspec `skipped` spam and non-first CI `waiting` polls in a stretch.
- [ ] Skill §4 (single-issue advance) and §4b (loop) orchestration text is **host-parameterized**: the mandatory progress step is "notify via host map," not an unconditional hard-require of `PushNotification` in prose that non-Claude hosts also consume.
- [ ] Dual-follow remains required after advance linkage (loop stream + linked advance stream until #611 demotes it); the material filter applies to both streams.
- [ ] Grok install/consumption path no longer teaches agents that Claude `PushNotification` is required: either `hosts/grok` (or equivalent first-class host packaging) or an explicit symlink + Grok §4 substitute that names `monitor` and the material filter.
- [ ] Host skill sections that name notify tools are drift-guarded so a Claude-only tool name cannot reappear in a Grok-consumed path without a Grok substitute; material-kind lists stay aligned with the shared filter.
- [ ] Spec/docs cross-link #725 (re-attach after wait cancel) and #611 (denser loop stage progress) and do **not** claim this change replaces them; re-arm guidance until `run_complete` / `loop_run_stopped` is stated.
- [ ] No engine stage handlers, review policy, auto-merge, push microservice, or stage-gating on "human saw a bubble" is introduced; `events.jsonl` remains the structured notify source.
- [ ] `npm run ci` is green after implementation (core tests, mirror check when packaging changes, install smoke, `openspec validate --all`).

## Capabilities

### New Capabilities

- `host-neutral-progress-notify`: Host notify map for material stage/loop progress (Claude / Grok / Codex surfaces), shared material filter over `events.jsonl`, host-parameterized skill §4/§4b notify guidance, Grok packaging substitute, and drift-guards that keep Claude-only tool names off Grok-consumed paths.

### Modified Capabilities

- `loop-skill-orchestration`: Material loop/advance notify guidance must be host-parameterized (notify via host map) rather than hard-requiring Claude `PushNotification`; dual-follow material kinds stay aligned with the shared filter; Grok/Codex-consumed paths must not inherit Claude-only tool hard-requires.
- `monitor-filter-guidance`: Extend host monitoring guidance from issue-scoped terminal-log filters to include (or cross-reference) the shared **events.jsonl material** filter used for progress notify across hosts.
- `log-follow-command`: Optionally allow a material-only follow path (e.g. `--material`) if implemented as engine UX; skill-side filter alone satisfies the issue when the engine flag is deferred.

## Impact

- **Host packaging:** `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, and a Grok path (`hosts/grok/SKILL.md` and/or install + documented substitute if #731 has not landed); generated `plugin/` mirror when host packaging changes.
- **Shared filter surface:** small script under skill/core (e.g. filter helper invoked from host monitor commands) and/or optional `pipeline logs` / `loop logs` material flag; unit tests with fixture event lines.
- **Drift tests:** packaging or prompt-loader-style checks for notify tool names and material kind lists per host.
- **Living specs:** new capability + deltas on loop orchestration, monitor filter guidance, and optionally log-follow.
- **Out of scope:** engine stage handlers, review policy, auto-merge, pipeline-owned push/Slack service, replacing `events.jsonl`, and wait-cancel re-attach semantics beyond re-arm until terminal (#725).
