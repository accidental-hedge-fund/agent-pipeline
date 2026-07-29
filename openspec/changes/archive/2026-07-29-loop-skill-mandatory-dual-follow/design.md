## Context

`pipeline:loop` orchestration (§4b) already requires following the **loop**
`events.jsonl`. Linkage events (`loop_item_advance_linked`, introduced by
loop-dispatch-advance-linkage) publish the real advance `pipeline_run_id` and
absolute `events` path once the child advance store is live. Stage-level
progress for an item is emitted on that advance store — not mirrored densely
onto the loop stream yet (#611 is the parent progress-surface issue; #682 is
pre-merge gate density).

Current host skill §4b.d and living requirement step 4 both say hosts may
**optionally** follow the advance stream. That under-specifies the only complete
progress path operators actually need during long item wall-clock.

This change is **documentation and contract only**: host `SKILL.md` variants,
living OpenSpec wording, and a cheap drift-guard. No supervisor or advance emit
behavior changes.

## Goals / Non-Goals

**Goals:**

- Make dual-follow **mandatory after linkage** in the harness orchestration
  contract (Claude + Codex + plugin mirror).
- Specify follow target preference, follow lifecycle (start / switch / stop), and
  material advance kinds for operator notifications.
- Keep loop-only follow valid for loop schedule/hold/terminal kinds; document why
  it is incomplete for mid-item stages until #611.
- Leave an explicit demotion path when #611 makes loop-only sufficient.

**Non-Goals:**

- Implementing #611 or #682 (engine event surface / pre-merge density).
- Changing loop supervisor emit, linkage event shape, or advance run-store layout.
- Forbidding operators from ignoring advance follow if they only care about
  item start/stop (the skill **SHALL** instruct dual-follow for complete
  orchestration; it does not add a runtime enforcer that kills loop-only
  consumers).
- Auto-merge, CI gate logic, or logs CLI feature work beyond documenting the
  preferred `logs … --events --follow` invocation.

## Decisions

### D1 — Modify `loop-skill-orchestration`, do not invent a new capability

**Choice:** Delta the existing capability’s ordered-protocol requirement and add
focused dual-follow / material-kinds / demotion requirements.

**Why:** Dual-follow is step 4 of the same harness protocol; a parallel
capability would split one operator-facing contract across two specs.

**Alternatives:** New `loop-skill-dual-follow` capability — rejected as
fragmentation for a wording tightening of one protocol step.

### D2 — Mandatory after linkage; still optional before linkage

**Choice:** When linkage publishes `pipeline_run_id` and/or absolute `events`,
the harness **SHALL** arm advance follow. Before any such publication, the
harness SHALL continue loop-only follow and MUST NOT require a non-existent
field.

**Why:** Matches engine reality (start linkage is emitted only after store
confirmation) and preserves the existing “no phantom linkage” scenario.

### D3 — Prefer CLI; accept absolute path

**Choice:** Prefer
`pipeline logs <advance-run-id> --events --follow` (or host-packaged
`pipeline.mjs logs …`) when the advance run id is known; absolute `events` path
from the linkage event is an acceptable follow target (e.g. `tail -F` or host
Monitor on the file).

**Why:** Matches single-issue §4 and existing §4b.d snippet; absolute path is
what linkage already guarantees when known (#dispatch-advance-linkage).

### D4 — Follow lifecycle is skill prose, not a new process manager

**Choice:** Document: on new item link, switch or add advance follow for the new
run; on terminal advance outcome (`run_complete` / equivalent terminal kinds),
stop the previous item’s advance follow; keep the loop follow until terminal
loop outcome or supervisor exit.

**Why:** Hosts already manage Monitors; mandating a specific process-supervisor
API is out of scope and host-dependent.

### D5 — Material advance kinds mirror §4

**Choice:** Surface at least `stage_start`, `stage_complete`, `pr_created`,
`review_verdict`, `gate_result`, `blocker_set`, `run_complete`; suppress pure
CI poll spam (`pre_merge.advancePolling` spirit from §4).

**Why:** Operators already know this set from single-issue advance; reusing it
avoids a second notification taxonomy.

### D6 — Cheap drift-guard on skill wording

**Choice:** If a co-located test can cheaply read host skill files (or built
plugin skill), assert that post-linkage dual-follow is not described solely as
“optionally follow” without mandatory language. Prefer substring / section
assertions similar to the existing loop packaging drift-guard, not a full
markdown AST.

**Why:** Issue acceptance asks for a guard “if cheap”; skill text has already
regressed in spirit when engine linkage shipped while docs stayed optional.

**Alternatives:** No guard (docs-only) — weaker; full SKILL parser — overkill.

### D7 — Demotion is future work in the #611 PR

**Choice:** Spec records that when #611 emits first-class stage progress on the
loop stream, this dual-follow **MAY** be demoted to optional/recommended for full
fidelity **in that PR**, with skill + living-spec update together. This change
does not implement demotion logic.

**Why:** Prevents permanent dual-follow obligation after the root cause is fixed,
without coupling this issue to unfinished engine work.

## Risks / Trade-offs

- **[Risk] Hosts ignore skill prose** → Mitigation: contract is intentional
  (same as rest of §4/§4b); no runtime enforcer in scope; drift-guard keeps the
  written contract honest.
- **[Risk] Double notification spam** (loop + advance) → Mitigation: distinct
  kind sets; suppress poll spam; loop stream stays sparse for schedule/terminal.
- **[Risk] Premature demotion language confuses implementers** → Mitigation:
  demotion gated on #611 shipping and explicit “MAY demote in that PR” wording.
- **[Risk] Codex/Claude skill drift** → Mitigation: tasks require both hosts +
  plugin mirror in one change; CI mirror check.
- **[Trade-off] Docs-only vs engine mirror (#611)** → Accept temporary dual-follow
  tax until engine density lands; issue explicitly defers engine work.

## Migration Plan

1. Land skill + OpenSpec + drift-guard + plugin mirror on the issue branch.
2. No data migration; no operator flag flips.
3. Rollback: revert skill/spec commit (no durable state).
4. When #611 merges: update skill + living spec to demote dual-follow if loop
   stream is sufficient; close or rewrite #684 accordingly.

## Open Questions

- None blocking implementation. Preferred Monitor tool names remain
  host-specific (Claude Monitor vs Codex equivalent) as today.
