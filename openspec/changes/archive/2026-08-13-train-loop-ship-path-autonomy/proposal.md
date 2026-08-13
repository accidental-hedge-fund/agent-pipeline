## Why

Buzz / Tugboat / `pipeline train --merge` still needs a human janitor on engine moles and on leftover `blocked` labels, even when no true human authority is required. Train is a second multi-item orchestrator (N×`single`, STOP on `blocked`) while loop already owns recovery, schedule, and parallel disjoint advance. Naive “loop everything to ready-to-deploy, then merge” breaks code-stacked `Depends on` edges because worktrees branch from `origin/<base>`, not parent PR heads. v1.38.1 ship-path autonomy must close those gaps so a milestone ship finishes without manual `unblock` or label surgery unless a real human decision is required.

## What Changes

- **Engine scratch recover (#1020):** Treat engine-owned scratch porcelain (e.g. `artifacts/challenge-response-*.json` class) as a deterministic recovery class. Run `unlink_engine_scratch` (or equivalent) before any implementer `repair_pipeline_item`. Scratch-only dirt SHALL NOT escalate to `pipeline:blocked` / `pipeline:needs-human` or train STOP.
- **Stale blocked re-review (#1025):** On enter pre-merge (including train/loop/single of an already-`blocked` item), when PR HEAD has moved past the blocking `reviewed-sha` by at least one non-pipeline-internal commit, clear `blocked` and re-run delta review. Do not `--override` security residuals. Pipeline-internal-only ranges keep today’s verdict reuse (#98).
- **Train∘loop base-eligible frontiers (#1023):** Replace production N×`single` advance inside train with a two-wave facade: for each base-eligible frontier, one multi-item loop/advance-wave (loop owns recovery and parallel disjoint advance); if `--merge`, a serial merge wave with squash-aware base containment. Code deps require merge+containment of the parent before the child advances. Independent R2D siblings may merge when a peer is parked (proven independence only).
- **Engine-class live sibling (#1021):** After first recovered engine-class fingerprint, file at most one live sibling on the **current train milestone** with `pipeline:ready` + engine-class markers, body `Depends on` the recovered item. Do not patch the victim PR with engine source. Reuse cross-host dedup/rate-cap; do not reverse #538 for papercuts/corrections.
- Preserve golden rules: advance never merges; no `auto_merge` config; no PR stacking onto parent PR head; no threshold→general LLM recover for engine-class faults.

Out of scope for this epic change:

- Continuous multi-repo `ship_model` (#1024).
- Human-question handoffs product work (#647 already shipped; does not fix false `needs-human`).
- Outcome feedback / learning loop (#576).
- Doctrine/run-memory preamble pin (#1030) and composition/FRG follow-through tests (#1029) as separate follow-ups.
- Hermes/Buzz factory control plane or second durable scheduler.

## Acceptance criteria

- [ ] Dogfood path: `pipeline train --merge --milestone <m>` survives #1013-class engine-scratch porcelain without manual `unblock` / label surgery and without train STOP solely for that scratch.
- [ ] Dogfood path: #691-class leftover `blocked` after a non-pipeline-internal commit past `reviewed-sha` is cleared and re-reviewed on next advance; train does not STOP before that resume attempt.
- [ ] Code-dep pair A→B (`Depends on` with code needed on base): train merges A and proves base containment of A’s merge-result before B’s advance wave starts.
- [ ] Independent ready-to-deploy sibling (no dep edge, independence proven) may merge while a peer item is parked / blocked; the parked item itself is not merged.
- [ ] After engine-class scratch recover, at most one milestone-scoped live sibling is filed for a given `evidence_key` in-window; the recovered item continues to ready-to-deploy without engine source patched into its PR.
- [ ] Product dirt (`core/`, dirty `openspec/`, other non-scratch paths) and true `human-decision-required` still fail closed / park; security residuals are not auto-overridden.
- [ ] Per frontier, train invokes one multi-item loop/advance-wave call (not N×`single`); unit tests inject loop/train deps with no real network, git, or subprocess.
- [ ] `plugin/` mirror stays in sync after any `core/` edit; `openspec validate train-loop-ship-path-autonomy` and `npm run ci` pass when implementation lands.

## Capabilities

### New Capabilities

- `engine-scratch-recover`: Deterministic classification and recovery of engine-owned scratch porcelain so scratch-only dirt recovers (unlink + clear block) without `needs-human` / train STOP, ordered ahead of implementer repair.
- `stale-blocked-rereview`: On enter of a blocked pre-merge (or equivalent) item whose HEAD supersedes the blocking `reviewed-sha` by a non-pipeline-internal commit, clear `blocked` and re-enter delta review without override.
- `engine-class-live-sibling`: After first recovered engine-class fingerprint during a train/ship, file at most one live `pipeline:ready` sibling on the current train milestone with `Depends on` the recovered item, using existing cross-host auto-file safety.

### Modified Capabilities

- `integrated-train-mode`: Train becomes a two-wave facade over base-eligible frontiers (loop advance wave + optional serial merge barrier); independent parked peers do not abort merge of proven-independent R2D siblings; production N×`single` advance loop is removed.
- `autonomous-recovery-controller`: Engine-scratch recovery recipe is claimed and ordered ahead of `repair_pipeline_item` for the engine-scratch / workflow-engine path; mechanical scratch recover does not create a human hold.

## Impact

- `core/scripts/stages/train.ts` (and related train composition): frontier selection, advance-wave injection of loop engine, merge-wave isolation, independent-sibling merge continuation.
- Recovery / pre-merge / dirt classification modules used by advance, single, loop, and train (scratch unlink recipe; stale-block resume on enter).
- Auto-file path for engine-class live siblings (narrow #538 exception; milestone + `pipeline:ready`; not papercut backlog).
- Unit tests under `core/test/` with injectable deps for frontiers, scratch recover, stale re-review, sibling file.
- `plugin/` regeneration after any `core/` change; operator docs only as needed for train∘loop behavior (doctrine pin is #1030).
- Downstream: Tugboat / ship playbook keep calling `train --merge`; no playbook fork required for this epic.
