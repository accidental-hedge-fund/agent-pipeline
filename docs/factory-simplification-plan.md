# Factory simplification plan (approved)

**Status:** approved 2026-08-09  
**Owner:** product direction for Hermes/Buzz factory + agent-pipeline train UX  
**Supersedes as startup architecture:** [grok-supervised-factory-plan.md](./grok-supervised-factory-plan.md) and the live `ops/hermes-factory` pilot as the *foundation* to grow  
**Does not delete:** pilot code, runbooks, or #898 lessons — freeze and harvest only

## Objective (acceptance tests)

| Objective | Pass condition |
|---|---|
| Describe work in Buzz | Natural language: single issue, issue list, or milestone |
| Single issue | Hermes calls agent-pipeline only; models/effort/stage machine come from `.github/pipeline.yml` |
| Group / milestone | Dependencies ordered; train is logical |
| Integrate between items | Each issue → `ready-to-deploy` → merge → next issue builds on that `main` |
| Milestone complete | Use agent-pipeline release path |
| Status without prompting | Periodic Buzz posts from real run state |
| Prefer built-ins | Outer layer is thin; Pipeline owns truth |

Target shape:

```text
Buzz intent
  → thin Hermes adapter
    → pipeline train (advance + merge-between)
      → pipeline release (prepare + authorized finish)
    → status heartbeat to Buzz
```

Not the startup shape:

```text
signed 9-action grant schema
  → second journal + systemd action bus
    → hybrid FRG attestor + pin promotion + install rollback
      → macro-controller + privilege broker + MCP
```

## Verdict on the Codex pilot

The pilot (`ops/hermes-factory`, ~12.5k LOC, `controller.mjs` ~2.8k) is a **second durable control plane** around agent-pipeline. It got several product truths right (one-item integrate waves, squash merge-result containment, Buzz is not the ledger, advance never merges by default) and buried them under grant theater, hybrid FRG, dual-engine pin bootstrap, and a roadmap (#890–#910) that would grow the outer product further.

**No existing factory mechanism is sacred.** Treat the pilot as a failed-but-informative artifact to harvest, not as the architecture to extend.

## Authority boundary (resolved conflict)

| Source | Claim |
|---|---|
| Golden rule | `advance` / `single` / default `loop` never merge |
| Factory goal | Milestone runs **must** merge between issues |
| Pilot design | Outer grant may merge; Pipeline stays pure |
| This plan | Opt-in **train / integrate mode** inside the Pipeline CLI is the only automated issue-train merge path |

Default loop remains stop-at-`ready-to-deploy`.  
`pipeline train --merge` (or equivalent) is **loop-isolated, explicit, opt-in** — same class as `pipeline merge` / `merge-queue --apply`, not silent advance-path merge. No `auto_merge` config key.

## Phases

### Phase 0 — Freeze and harvest

- Freeze growth of #890–#910 as a sequential “must ship factory product.”
- Do not expand `ops/hermes-factory` unless the operator explicitly requests pilot recovery only.
- Keep-list from the pilot:
  - one-item integrate sequence
  - squash merge-result containment (merge commit, not PR head)
  - Buzz status thread idea
  - #905 dependency discovery
  - advance never merges by default
- Kill-list for startup:
  - grant schema as operator UX
  - hybrid FRG as train gate
  - second durable journal as authority
  - pin/install as day-one factory work

### Phase 1 — Product train in agent-pipeline (highest ROI)

Add a first-class integrate train that composes existing primitives:

```text
pipeline train --milestone vX.Y.Z [--issues N,M] [--merge] [--release X.Y.Z]
```

When `--merge`:

1. Resolve ordered work list (declared deps + optional explicit order).
2. For each issue: prior merges contained in `origin/<base>` → advance to R2D → `pipeline merge` on linked PR → fetch base → prove squash-aware containment → next.
3. Capacity 1 while integrate mode is on.
4. `needs-human` / blocker → pause with clear status; resume is explicit.
5. Emit train events to JSONL for supervisors.
6. Reuse loop store + GitHub as truth — **no second journal**.

OpenSpec change: `add-integrated-train-mode`.

Also in Phase 1 engine stability (block any outer wrapper):

- plan-review / mid-stage resume after process death
- ownership-set GC (worktree, marker, run-store, lock, failed unit)
- land or drop active P0 train bugs (#874, #870) before relying on a pilot train

### Phase 2 — Thin Hermes adapter

Buzz intents:

- `/pipeline-factory #874`
- `/pipeline-factory issues 905 874 870`
- `/pipeline-factory milestone vX.Y.Z`
- `/pipeline-factory status`
- `/pipeline-factory stop`

Hermes parses intent, starts **one** `pipeline train ...` (or `pipeline single` for one issue), does **not** invent models/effort/stages/merge policy, posts status from train/loop JSON on a timer.

Pilot-honest authority: private channel + operator allowlist + machine-local enable/expiry file. No claim of cryptographic isolation on same UID.

### Phase 3 — Release completion (optional per train)

- `pipeline release` stays prepare-only.
- Add authorized finish (`pipeline release finish <pr>` or documented merge-queue companion).
- agent-pipeline self-release: keep existing FRG requirements.
- Other repos: follow `pipeline.yml` / release policy only.

### Phase 4 — Self-host upgrade (optional)

Pin promote / install / FRG attestation isolation only after Phases 1–3 work for ordinary milestones.

## Open issue re-triage

### Keep / reshape

| Issue | Action |
|---|---|
| #901 | Reshape to minimal train/integrate mode (this plan’s Phase 1) |
| #765 | Fold into train mode (post-ready merge + base refresh) |
| #874, #870 | Engine P0s — fix or remove from any live train |
| #891 | Thin status JSON over loop/train **without** requiring #890 |
| #908 / #902 | Thin release prepare→finish; drop two-call ceremony as startup |
| #905 | Done — use it |

### Park / demote (not factory blockers)

| Issues | Why |
|---|---|
| #890 macro-controller | Duplicates train + loop |
| #892–896 factory ops suite | Premature surface |
| #897 Hermes outer-host tools | Skill + CLI is enough |
| #899, #618 isolation | Later hardening |
| #900 multi-profile merge | Later |
| #903 engine promotion | Later self-host |
| #906 qualified merge frontier | Later |
| #907 MCP | Explicit later |
| #909–910 SemVer polish | Hygiene, not train blockers |
| #662 shadow-calibrated autonomous merge | Research track |

### PR note

PR #911 (#891) tracks the macro-controller direction. Do not merge as “the factory” without re-scoping status to thin train/loop status.

## Success metric

A contributor can run:

```bash
pipeline train --milestone vX.Y.Z --merge
```

from a clean install with only `pipeline.yml` + `gh` auth, and optionally wire Buzz as a dumb notifier — without reading an 800-line factory runbook.

## Explicit non-goals (next 2–3 releases)

- Macro-controller (#890) as designed
- Privilege broker (#899)
- MCP (#907)
- Full factory event bus (#892–896)
- Growing `ops/hermes-factory` further

## Related docs

- Pilot handoff: session handoff under worktree `docs+hermes-factory-session-handoff` (historical)
- Pilot plan (superseded for startup): [grok-supervised-factory-plan.md](./grok-supervised-factory-plan.md)
- Pilot deploy: [runbooks/hermes-factory-deployment.md](./runbooks/hermes-factory-deployment.md)
- OpenSpec: `openspec/changes/add-integrated-train-mode/`
