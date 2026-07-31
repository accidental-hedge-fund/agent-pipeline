## Context

Progress visibility for long-running `/pipeline` and `/pipeline:loop` runs is a
**host skill orchestration** concern, not an engine stage concern.

Today:

| Layer | Role |
| --- | --- |
| Engine | Appends structured lifecycle events to host-agnostic `events.jsonl` (advance run store and durable loop store). |
| CLI | `pipeline logs <run-id> --events --follow` and `pipeline loop logs … --events --follow` stream raw JSONL. |
| Host skill §4 / §4b | Tells the harness how to arm follows and **notify the human** on material events. |

Claude packaging hard-codes `PushNotification` in §4.d and §4b.e. Codex already
uses chat updates without that tool. Grok has no `PushNotification`; its working
equivalent is the host **`monitor`** tool (each stdout line becomes a chat
notification). Grok often installs the **Claude** skill overlay (symlink /
shared path; first-class `--host grok` is #731). Agents then:

1. Try to call a tool that does not exist, or
2. Arm dual **raw** JSONL monitors (noise + Monitor auto-stop risk), or
3. Invent side-channel relays when wait-cancel breaks re-attach (#725).

In-session dogfood on Grok showed that a **material-filtered** `monitor` on
`events.jsonl` already produces the right bubble class for single-issue advance
(#718, #722). Loop runs still go quiet under Claude-shaped guidance.

Architecture constraint (issue + living packaging model): keep notify in the
**host skill overlay**; keep the factory on **structured events**. Do not build
a pipeline-owned push service or gate stages on delivery.

## Goals / Non-Goals

**Goals:**

- Define a **host notify map** (Claude / Grok / Codex) so every host has an
  explicit, host-correct way to surface material progress.
- Provide a **shared material filter** over `events.jsonl` so monitors print
  skill-material one-liners only (advance + loop kinds from the issue).
- Make §4 / §4b **host-parameterized**: "must notify via host map," not bare
  `PushNotification` in shared or cross-host-consumed prose.
- Ensure the path Grok agents actually load never hard-requires Claude-only
  tools without a Grok substitute.
- Drift-guard notify tool names and material kind lists.
- Keep dual-follow mandatory after linkage; apply the material filter to both
  streams; cross-link #725 and #611 without absorbing them.

**Non-Goals:**

- Engine stage handlers, review policy, auto-merge.
- Pipeline-owned push / Slack / Discord default integration.
- Gating stage advancement on "human saw a bubble."
- Replacing `events.jsonl` with a new notify protocol.
- Fixing wait-cancel re-attach semantics (#725) beyond documenting re-arm until
  `run_complete` / `loop_run_stopped`.
- Implementing denser loop stage progress (#611).
- Making first-class `--host grok` install the sole deliverable of this change
  if #731 is still open — a documented Grok substitute on the path Grok
  actually installs is enough.

## Decisions

### D1 — Notify stays in host overlays; filter is a shared skill-side helper

**Choice:** Progress **notification** is prescribed only in host skill
packaging (`hosts/<host>/SKILL.md` and generated mirrors). The **material
filter** is a small shared helper (Node script under `core/scripts/` or a
host-shared path the skill can invoke) that reads JSONL and prints material
one-liners to stdout. Hosts wire their own surface to that stream:

| Host | Follow / surface | Material path |
| --- | --- | --- |
| Claude | Monitor on filtered CLI/script stdout; `PushNotification` on material lines | Unchanged intent |
| Grok | Host `monitor` on the same filtered command (each line = bubble) | Never call `PushNotification` |
| Codex | Poll/follow filtered stream; concise chat updates | No Claude tool names |

**Why not engine-only notify:** Engine already has the event stream; inventing a
push service would couple delivery to stages and duplicate host chat channels.
**Why not pure prose without a filter:** Agents mis-arm raw JSONL tails; a
deterministic filter is the shared truth for "what is material."

**Alternatives considered:**

- *Host-neutral §4 only, no Grok file* — still leaves Claude overlay consumers
  with `PushNotification` hard-requires; insufficient for Grok-on-Claude-install.
- *Engine flag only (`logs --material`)* — better UX long-term, but optional for
  this issue if the skill-side script lands first (see D3).

### D2 — Host packaging strategy: host map + Grok path (coordinate with #731)

**Choice:** Every host overlay carries an explicit **Host notify map** section
(or §4 subsection) naming that host's tools. Shared wording for the mandatory
step is: **notify via the host map** on material filter output.

Grok path (pick first available at implement time):

1. **Preferred when #731 (or equivalent) has landed:** first-class
   `hosts/grok/SKILL.md` installed via `install.mjs --host grok`, with Grok
   `monitor` + material filter and **no** `PushNotification` hard-require.
2. **Otherwise for this issue:** keep install as-is, but ensure the skill file
   Grok actually loads either (a) is a Grok-specific overlay, or (b) includes a
   clearly labeled **Grok substitute** for §4/§4b notify that supersedes Claude
   `PushNotification` when the host is Grok — and drift-guard that substitute.

**Why not wait solely on #731:** Operators already run Grok against Claude
packaging today; this issue's user-visible failure is notify guidance, which can
be fixed without finishing full Grok host discovery/install.

**Alternatives considered:**

- *Single host-neutral SKILL for all hosts* — fights existing claude/codex
  packaging split and host-specific setup paths; rejected for this change.
- *Only document in README* — agents load SKILL.md, not README; rejected.

### D3 — Material filter: skill-side first; engine `--material` optional

**Choice:** Ship a pure, unit-testable filter (stdin or file path → stdout
one-liners or passthrough JSONL lines that are material). Host skill examples
compose it with existing follow:

```text
pipeline logs <run-id> --events --follow | <material-filter>
# or: material-filter --follow <events.jsonl>
```

Optional: add `pipeline logs … --events --follow --material` (and loop logs
parity) as **UX sugar** reusing the same pure function. Not required for issue
done if skill-side composition works and is documented in every host overlay.

**Material advance kinds (must pass):**
`run_start`, `stage_start`, `stage_complete`, `pr_created`, `pr_updated`,
`review_verdict`, `gate_result` (with spam rules), `blocker_set`,
`blocker_cleared`, `run_complete`.

**Material loop kinds (must pass):**
`loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`,
`loop_item_advance_linked`, advance finished / equivalent terminal item-advance
kinds already named in skill text, `loop_item_stage_progress`, material
`loop_item_progress`, `loop_run_stopped`.

**Suppression rules (deterministic):**

- Repeated identical CI polling / `pre_merge.advancePolling`-style bursts: first
  material gate event only.
- Repeated CI `partial` and OpenSpec `skipped` spam: suppress.
- `loop_item_progress` with CI `waiting`: first only per stretch; definitive
  outcomes always material.
- Heartbeats / accounting / non-listed kinds: drop for notify path.

**Output shape:** Prefer short human one-liners suitable as Monitor/chat bubbles
(host skill may still map one-liner → `PushNotification` text). Passthrough of
filtered JSONL is acceptable if hosts format locally — pick one in
implementation and drift-guard examples; prefer one-liners for Grok `monitor`.

**Alternatives considered:**

- *Only document a shell one-liner* — fragile and drifts; script + tests preferred.
- *Filter inside engine append path* — would change evidence stream; rejected
  (`events.jsonl` stays complete).

### D4 — Host-parameterize §4 / §4b without rewriting all orchestration

**Choice:** Keep the ordered orchestration steps (status → detach/launch →
follow → notify → stop → summarize). Change only the **notify** step language:

- Shared contract (specs + any shared prose): "on each material filter line,
  notify via the host map."
- Claude host file: may still name `PushNotification` as **that host's** map
  entry.
- Grok / Codex: name only their surfaces.

Update `loop-skill-orchestration` requirements that currently say "notification
or Push" so they do not imply Claude Push is universal. Dual-follow lifecycle,
same-turn stop, and material kind lists remain; align kind lists with D3.

### D5 — Drift guards

**Choice:** Add (or extend) CI-covered tests that:

1. Fail if a **Grok-consumed** skill path hard-requires `PushNotification`
   without a Grok `monitor` (or documented host-map) substitute.
2. Fail if Claude host loses its map entry for material notify (regression of
   Claude intent).
3. Assert material kind allow-lists in skill text match the shared filter's
   kind set (or a single exported constant used by both tests and filter).
4. Keep existing dual-follow / no-seconds-only loop guards.

Prefer a single source of truth (e.g. `MATERIAL_EVENT_KINDS` constant or
JSON/YAML list) imported by the filter and asserted by skill substring tests.

### D6 — Cross-links and re-arm

**Choice:** Skill §4 / §4b notify/follow guidance SHALL state:

- Re-arm follow after wait cancel until `run_complete` (advance) or
  `loop_run_stopped` (loop); full re-attach semantics remain #725.
- Dual-follow density / demotion remains gated on #611 (and pre-merge density
  #682 where already documented).

No new engine behavior for re-attach.

## Risks / Trade-offs

- **[Risk] #731 timing** → Grok still loads Claude overlay after this lands.  
  **Mitigation:** D2 fallback requires a Grok substitute or Grok overlay on the
  path Grok actually installs; drift-guard covers that path.

- **[Risk] Material filter under/over-filters** → quiet runs or spam.  
  **Mitigation:** Unit tests with fixture JSONL covering allow, suppress, and
  first-waiting rules; dogfood against real advance/loop event samples if
  available in fixtures.

- **[Risk] Skill prose duplication across hosts** → drift between Claude/Codex/Grok.  
  **Mitigation:** Shared kind constant + drift tests; host map only differs on
  tool names.

- **[Risk] Optional engine `--material` deferred** → worse UX for humans using
  bare CLI.  
  **Mitigation:** Acceptable for issue scope; skill agents use the scripted
  composition; flag can land in same PR if cheap.

- **[Risk] Confusing Monitor (Claude) vs monitor (Grok)** → agents mix tools.  
  **Mitigation:** Host map table names tools per host; never instruct Grok to
  call Claude Monitor/PushNotification.

## Migration Plan

1. Land shared material filter + unit tests (no host behavior change yet).
2. Update host SKILL.md files (Claude map explicit; Codex map explicit; Grok
   path per D2); regenerate `plugin/` if mirror includes host skill.
3. Wire drift guards; update `loop-skill-orchestration` / `monitor-filter-guidance`
   living-spec deltas via this change (archive at pre-merge as usual).
4. Optional: engine `--material` flag reusing the same pure filter.
5. Rollback: revert packaging + filter; engine event stream unchanged so
   rollback is safe.

## Open Questions

- Exact install location for Grok skills if #731 is not yet merged (confirm at
  implement time against current `install.mjs` and operator symlink practice).
- Whether material filter stdout is **one-liners only** vs filtered JSONL
  (design preference: one-liners; implementers may keep a `--json` debug mode).
- Whether `loop logs` and advance `logs` both get `--material` in the same PR
  or only the skill-side script (default: skill-side required; flags optional).
