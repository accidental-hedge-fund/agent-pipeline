## Context

Single-issue default advance already has a working **detach + run-store** contract:

1. **Engine** — `pipeline run <N> --detach` returns a wrapper dir; canonical evidence
   lives under `.agent-pipeline/runs/<run-id>/` with `events.jsonl`, `terminal.log`,
   `summary.json`, and `run_complete` finalization (`type: "run_complete"` in the
   advance event schema — field name is `type`, not loop’s `kind`).
2. **CLI observation** — `pipeline logs <run-id> --events --follow` streams
   `events.jsonl` (capability `log-follow-command`). Today follow remains open until
   interrupt; it does **not** auto-exit on `run_complete`.
3. **Host skill §4** — `hosts/claude/SKILL.md` / `hosts/codex/SKILL.md` instruct:
   status pre-check → detach → Monitor on `logs … --events --follow` → push on
   material events → stop on `run_complete` / sentinel → `summary <run-id>`.
   There is **no** mandatory same-turn re-attach if the follow tool is cancelled,
   times out without re-arm, or the session loses the wait.

Durable **loop** already solved the complementary problem (#699 /
`loop-event-follow-terminal-exit`): until-terminal default on
`pipeline loop logs … --follow`, same-turn stop language, and skill drift-guards.
This change applies that discipline to **single-issue advance host follow**, with
extra emphasis on **re-attach after interrupt** (the observed factory failure mode).

## Goals / Non-Goals

**Goals:**

- Make cancelled / interrupted / timed-out follow **before terminal** a
  non-terminal recovery event: same-turn liveness check + re-arm + continue.
- Document a run-store-id re-attach path operators and hosts can use after session loss.
- Drift-guard high-traffic §4 text so re-attach language cannot silently disappear.
- Prefer a first-class until-terminal exit on advance `logs --events --follow` for
  `run_complete`, so hosts wait on process exit rather than fragile Monitor lifetime.
- Keep terminal summary + same-turn follow teardown as the only successful handoff end.

**Non-Goals:**

- Changing advance stage handlers, review policy, labels, or merge behavior.
- Fixing durable multi-item loop resume stranding (#712).
- Cross-host locks or dual-lock redesign (#634).
- Auto-killing unrelated Monitors (other issues/run ids) in the host session.
- Requiring a brand-new subcommand name if composed `logs` + `summary` already
  satisfies “supervise until terminal” (thin alias is optional).

## Decisions

### D1 — Skill contract is the primary fix; CLI until-terminal is preferred co-delivery

**Choice:** Spec and implement host-skill re-attach language as **mandatory** for
done. Ship advance logs until-terminal-on-`run_complete` in the **same change**
unless a hard technical blocker appears; treat “CLI only later” as a degradation,
not the preferred plan.

**Why:** The observed failure is host behavior after interrupt. Skill text alone
makes the contract installable and drift-guardable. Until-terminal CLI makes
compliance easier (wait on exit 0) and matches loop precedent — without it, hosts
still re-implement “when to stop” in Monitor glue.

**Alternative considered:** Skill-only PR first. Rejected as default because the
issue’s preferred AC explicitly wants a supervise-until-terminal process, and loop
already paid for the line-aware follow pattern.

### D2 — Re-attach protocol steps (same turn, ordered)

**Choice:** On cancelled/interrupted/timed-out wait **before** terminal, host
skill SHALL require **in the same harness turn**:

1. **Liveness** — determine whether the detached run is still live or already
   terminal via at least one of: wrapper `sentinel.json`, presence of
   `run_complete` in events / finalized summary, `pipeline status <N>`, or
   process liveness if the host still holds the detach pid.
2. **If already terminal** — skip re-follow; run `pipeline summary <run-id>`
   (or equivalent), emit final operator summary, stop any remaining follows.
3. **If still live or unknown-not-terminal** — re-arm
   `pipeline logs <run-id> --events --follow` (or host-equivalent follow on the
   same run-store `events.jsonl`), continue until `run_complete` / sentinel.
4. **Then** emit final summary and stop follows.

**Why:** “Same turn” matches loop §4b.f discipline and prevents “I’ll check later”
silence. Checking liveness first avoids spinning a follow forever on a finished run
when the host only missed the terminal event.

### D3 — Cancelled wait ≠ terminal (explicit anti-pattern)

**Choice:** Skill text SHALL state that tool cancel, Monitor stop, wait timeout,
and session pause **are not** pipeline terminal outcomes and **must not** end
supervision without liveness + re-attach or confirmed `run_complete` / sentinel.

**Why:** Agents treat cancel as “task done enough.” Naming the anti-pattern makes
the drift-guard searchable and reviewable.

### D4 — Advance logs until-terminal defaults on for `--events --follow`

**Choice:** Mirror loop logs:

| Surface | Behavior |
| --- | --- |
| `logs <run-id> --events --follow` | until-terminal **on** → exit 0 after printing a `run_complete` line |
| `--no-until-terminal` | interrupt-only (current behavior) |
| `--until-terminal` | optional affirm of default |
| `--follow` without `--events` (terminal.log) | **interrupt-only remains** unless a clear shared design says otherwise — raw terminal has no single structured completion line as reliable as `run_complete` |
| dump without `--follow` | unchanged |

Terminal detection: complete JSONL line with advance event `type === "run_complete"`
(confirm against `run-store.ts` writers — do not invent fields). Historical
`run_complete` already in the file ends follow without hang.

**Why `--events` only by default:** Skill §4c’s primary path is `--events`. Raw
`terminal.log` follow is a fallback for prose; auto-exit heuristics on unstructured
logs are brittle. Scope until-terminal to the structured stream first.

**Implementation approach:** Reuse or extract the loop’s line-aware follow seam
(`followEventsWithTerminalExit` or shared helper) with a pluggable terminal
predicate (`type === "run_complete"` vs loop `kind === "loop_run_stopped"`). Unit
tests inject lines; no real tail/subprocess required.

### D5 — Supervise-until-terminal as documented composition, optional thin CLI

**Choice:** Document the non-interactive pattern as:

```bash
pipeline logs <run-id> --events --follow && pipeline summary <run-id>
```

(with until-terminal default). A thin `pipeline supervise <run-id>` (or
`logs … --summary-on-exit`) MAY be added if packaging needs a single argv, but
is not required if the composed one-liner is first-class in skill + help.

**Why:** Minimal surface; summary already exists domain-independently by run id.

### D6 — Drift-guard placement and strings

**Choice:** Add/extend a packaging or host-skill test under `core/test/` (same
family as loop-skill / prompt-loader drift guards) that fails when
`hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` §4 (or successor heading)
drop **all** of:

- re-attach / re-arm after cancelled or interrupted follow,
- cancelled wait is not terminal,
- continue until `run_complete` (or sentinel) before final summary.

Guard SHOULD search substantive phrases (not a single brittle full paragraph) so
legitimate rewording can pass if the three obligations remain. Plugin mirror is
generated from hosts — guard hosts sources (and/or built plugin skill if that is
the install surface under test), consistent with existing mirror discipline.

### D7 — Out of scope for durable loop dual-follow

**Choice:** Do not re-open loop dual-follow or #712 in this change. Single-issue
§4 only. If loop advance-follow sub-paths need the same re-attach sentence, a
follow-up may copy language; not required for #725 AC.

## Risks / Trade-offs

- **[Risk] Hosts ignore skill text anyway** → Mitigation: until-terminal CLI makes
  the happy path a process wait; drift-guard keeps text; factory reliability
  framing treats missing handoff as product fault when skill was followed.
- **[Risk] BREAKING: scripts that assumed infinite `logs --events --follow`** →
  Mitigation: `--no-until-terminal` opt-out; document in help/CHANGE notes;
  default matches harness needs (majority).
- **[Risk] False terminal detection on wrong field** → Mitigation: confirm
  `type: "run_complete"` against writers; unit tests with real fixture shapes.
- **[Risk] Over-strict drift-guard flakes on prose edits** → Mitigation: multi-
  obligation phrase set, not one exact paragraph hash.
- **[Risk] Confusing sentinel vs run_complete** → Mitigation: skill treats either
  as terminal stop condition (already §4e); re-attach liveness may use both.

## Migration Plan

1. Land OpenSpec change (this proposal/design/specs/tasks).
2. Implement skill §4 text + drift-guard (always).
3. Implement advance logs until-terminal + tests; update help/one-liners.
4. `node scripts/build.mjs` for plugin mirror; `npm run ci`.
5. No data migration; no GitHub schema change. Operators with long-lived dashboards
   add `--no-until-terminal`.

Rollback: revert packaging + CLI default in one PR; opt-out already provides
soft rollback for consumers.

## Open Questions

- Whether to auto-exit `--follow` on `terminal.log` (non-`--events`) using
  sentinel.json side-channel — **default no** in this design; open only if dogfood
  shows hosts rely on raw terminal follow for completion.
- Whether a named `pipeline supervise <run-id>` subcommand is worth command-surface
  budget vs documented composition only — decide during implementation if packaging
  table space is tight; composition is sufficient for AC.
