## Context

See `proposal.md` for motivation. Current product state that shapes this design:

- **Train** (`integrated-train-mode`) already resolves a work list and, under `--merge`, advances then merges serially with squash-aware base containment. Production advance path today is N×`single` (or equivalent one-item advance). On leftover `blocked` / `needs-human`, train STOPs the whole ship.
- **Loop** already owns multi-item recovery ledger, independent-item continuation, conflict-aware concurrency, and host-local issue-run locks. Advance never merges (golden rule #4).
- **Recovery controller** has recipe ordering and human-hold predicates, but engine-scratch porcelain still escalates as false human work on some paths (dogfood #1013).
- **Pre-merge** can self-heal a stale block only when HEAD moves *while* `setBlocked` is being written; a later advance that re-enters an already-blocked item with a newer developer/fix HEAD still STOPs (dogfood #691 / PR #1022).
- **Auto-file (#538)** files papercuts/corrections/durable-run-blockers as `pipeline:backlog` only, never milestone-assigned — so engine fixes cannot join the current train without a human.

Child land order (spine): `#1020` + `#1025` (parallel) → `#1023` (frontiers) → `#1021` (sibling) → dogfood ship of v1.38.1.

## Goals / Non-Goals

**Goals:**

- One shared advance brain: train schedules frontiers; loop recovers and co-advances within a frontier.
- Preserve integrate barrier for code deps: merge + base containment before dependent advance.
- Kill false `needs-human` for engine-scratch and stale-block identity drift without weakening true authority holds.
- File durable engine fixes as live milestone siblings without patching victim PRs.
- Keep Tugboat / ship playbook calling `train --merge` unchanged at the outer surface.

**Non-Goals:**

- PR stacking / branching child worktrees from parent PR heads.
- Parallel merges or parallel `engine-promote`.
- All-milestone one-shot loop then single merge wave.
- Threshold → general LLM recover for arbitrary blocks.
- Continuous multi-repo ship model (#1024), doctrine memory pin (#1030), FRG composition suite (#1029) as this change’s deliverables.
- Reversing #538 for papercuts/corrections.
- `auto_merge` config or merge-from-advance.

## Decisions

### 1. Train is a two-wave facade over loop, not a second recovery engine

**Choice:** `runTrainCommand` (or equivalent) repeatedly:

1. Resolve work list (existing milestone / issues + declared deps).
2. Compute **base-eligible frontier**: items whose code prerequisites are integrated (merge-result contained in fetched base) and that may co-advance under ownership/conflict rules.
3. **Advance wave:** one injected `runLoopEngine` / `runAdvanceWave` call with that frontier only.
4. If `--merge`: **merge wave** — serial existing `mergePr` + containment for R2D items in the frontier that are not already integrated.
5. Recompute frontier until work list exhausted or only non-progressing holds remain.

**Why:** Loop already owns recovery, resume, and parallel disjoint advance. Reimplementing multi-item advance inside train caused STOP-on-first-block and missed recover recipes.

**Alternatives:** Keep N×`single` + ad-hoc recover in train (rejected: second brain). One loop over whole milestone then merge all (rejected: breaks code-stacked deps).

### 2. Unknown dependency kind fails closed as code dep

**Choice:** When `Depends on` does not declare a schedule-only edge, treat the edge as a **code dependency**: dependent MUST NOT enter an advance wave until the prerequisite’s merge-result is contained in the configured base. Document schedule-only edges only if a first-class marker already exists; do not invent soft “probably independent” heuristics.

**Why:** Worktrees use `origin/<base>`. Child code that needs parent commits fails or ghosts if advanced early.

**Alternatives:** Always serial entire work list (too slow; independent peers lose concurrency). PR-head stacking (out of scope).

### 3. Independent parked peer does not abort sibling merge

**Choice:** After an advance wave, if item P is held/blocked and item S is R2D with **no** dependency edge to/from P and independence proven from ledger/deps (and concurrency policy), merge wave MAY merge S. Fail closed when independence cannot be proven. P itself is never merged while blocked.

**Why:** Whole-train STOP on one false or real park kills independent ready work (ship janitor pain).

**Alternatives:** Always STOP on any block (status quo; rejected for ship autonomy). Soften dep graph with heuristics (rejected).

### 4. Engine scratch: deterministic unlink recipe before implementer repair

**Choice:** Add a pure classification of engine-owned scratch-only porcelain (shared with existing non-product scratch sets, at least challenge-response dumps and known pipeline markers). Recovery recipe `unlink_engine_scratch` (unlink/restore scratch paths + clearBlocked when block was scratch-only) is ordered **ahead of** `repair_pipeline_item` for the workflow-engine / engine-scratch path. Product dirt still blocks. No auto-commit of scratch into product tree. No broad `artifacts/**` waiver.

**Why:** #1013-class porcelain is engine-owned; LLM repair and needs-human are the wrong tools.

**Alternatives:** Threshold LLM recover (rejected). Only prevent setBlocked without recover of already-blocked items (incomplete for resume).

### 5. Stale blocked resume on enter, not only mid-write

**Choice:** When entering pre-merge (or the advance path that would otherwise treat leftover `blocked` as terminal for train), load latest blocking delta/review `reviewed-sha` S and PR HEAD H. If H is a descendant of S (or S absent after rebase) **and** `S..H` contains at least one non-`isPipelineInternalCommit` commit: `clearBlocked`, re-run delta review (or the existing full re-review used when HEAD moves mid-write). Do not auto-override security keys. If H == S with residuals, keep block. Pipeline-internal-only range keeps verdict (#98).

**Why:** Dogfood #691 fixed the residual then stopped on stale label; operator clear + re-single approved.

**Alternatives:** Train ignores `blocked` always (unsafe). Override on any new commit message (unsafe).

### 6. Live sibling is a narrow auto-file exception, not papercut policy reversal

**Choice:** After first successful recover of an engine-class fingerprint (`workflow-engine-defect` / engine-scratch class), file **one** sibling keyed by `evidence_key` via the existing cross-host-safe auto-file path (pre-create GitHub state + post-create reconcile). Labels: `bug` + `pipeline:engine-class` + `pipeline:ready` (not backlog). Milestone = current train milestone from train/loop run context when known; otherwise file without milestone (no guess). Body includes `Depends on: #<recovered>`. Victim item continues to R2D without engine patch. Product/human-decision paths never trigger.

**Why:** Durable fix must land in this release train; #538 backlog-only policy would leave the ship waiting on human triage.

**Alternatives:** Patch engine fix into victim PR (rejected: scope contamination). Always backlog (status quo; rejected for ship). LLM classifies engine vs product (rejected; typed diagnostic only).

### 7. Land order and seams

**Choice:** Implement recover recipes (#1020, #1025) first so loop advance waves heal moles. Then rewire train frontiers (#1023). Then sibling file (#1021), preferring the train-milestone seam from #1023 but allowing an explicit milestone argument if needed.

**Why:** Composition without recover still STOPs; sibling without recover files noise; frontiers without recover waste parallel advance.

## Risks / Trade-offs

- **[Risk] Frontier computation wrong → early dependent advance** → Mitigation: fail closed on unknown edges; unit tests for A→B containment barrier; no soft “maybe schedule-only.”
- **[Risk] Independent merge while peer blocked merges unsafe pairs** → Mitigation: require proven independence from declared deps + ownership/conflict ledger; otherwise serialize / stop.
- **[Risk] Scratch unlink deletes operator work under `artifacts/`** → Mitigation: only engine-known scratch globs; never entire `artifacts/**`; product paths still block.
- **[Risk] Stale re-review loops (#98 cascade)** → Mitigation: pipeline-internal-only ranges keep verdict; only non-internal commits invalidate.
- **[Risk] Live sibling spam** → Mitigation: first-occurrence `evidence_key` + existing rate-cap/dedup/reconcile; product and human-decision never file.
- **[Risk] Train still exposes N×single in some code path** → Mitigation: unit test asserts one advance-wave call per frontier; remove production N×single loop.

## Migration Plan

1. Land OpenSpec change (this planning commit).
2. Implement #1020 and #1025 behind existing deps seams; green unit tests; regenerate `plugin/` if `core/` touched.
3. Implement #1023 train facade; keep CLI flags (`--merge`, `--milestone`, `--issues`); Tugboat unchanged.
4. Implement #1021 sibling file with train-milestone context.
5. Dogfood `pipeline train --merge --milestone` for v1.38.1 spine.
6. Archive OpenSpec change at pre-merge when implementation ships.

Rollback: revert the PR(s); train falls back to prior serial N×single behavior only if a full revert of #1023 is needed — prefer forward-fix of frontier bugs.

## Open Questions

None that block specs or task breakdown. Follow-ups #1029 (FRG composition tests) and #1030 (doctrine/run-memory preambles) stay outside this change’s apply gate.
