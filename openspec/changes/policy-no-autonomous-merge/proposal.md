## Why

Repo-facing merge policy is both factually false and stricter than the maintainer intends. CLAUDE.md golden rule 4 and the `pipeline-state-machine` "Never auto-merge" requirement still claim there is no merge path and "no merge command anywhere in the orchestrator or stage handlers," while operator-invoked merge surfaces have already shipped (`pipeline merge <pr>`, `merge-queue --apply` + `--release-when-complete`). The 2026-07-31 reliability audit left this as its last unresolved policy decision; the maintainer ruled that the durable invariant is **no autonomous/unattended merge**, not "no merge capability."

## What Changes

- Reword CLAUDE.md golden rule 4 (and AGENTS.md mirror) to the ruling: **no autonomous merges** — the advance loop stops at `pipeline:ready-to-deploy`; merging happens only through explicit operator invocation (`pipeline merge` / `/pipeline:merge` per-PR; `merge-queue --apply` batch, dry-run default); the invoking operator is the session-bound merge authority; no `auto_merge` config key and no unattended merge path — don't add either; unattended merge remains gated on #662's shadow-calibrated evidence standard.
- Correct `pipeline-state-machine` "Never auto-merge (structural guarantee)": replace the false "no merge command anywhere in the orchestrator or stage handlers" claim with the accurate structural claim — no merge stage in `STAGES`, no merge call **reachable from `pipeline advance`**, merge surfaces exist only behind explicit operator commands — and name `merge-queue --apply` alongside `pipeline merge` in the carve-out paragraph. Keep the `auto_merge` strict-rejection requirement and its scenario unchanged in meaning.
- Align public positioning (README, hosts/*/SKILL.md, related "never merges" one-liners that describe the product boundary) so they name the current boundary precisely: agent-pipeline is autonomous from issue intake through a green, current, mergeable `ready-to-deploy` result; merge requires explicit session-bound operator authority; autonomous deployment is out of scope. Do **not** describe the current product as an autonomous end-to-end SDLC/ADLC.
- Preserve structural tests (no stage transition calls merge-queue; `auto_merge` rejected at parse); keep/add a drift-guard that `mergePr` is unreachable from the advance loop.
- Docs-and-spec only: **zero runtime behavior change**.

## Acceptance criteria

- [ ] CLAUDE.md golden rule 4 states **no autonomous merges** (advance stops at `ready-to-deploy`; merge only via explicit operator invocation of `pipeline merge` / `merge-queue --apply`; no `auto_merge` config key; unattended merge deferred to #662) rather than "the pipeline never merges" / "there is no auto-merge path."
- [ ] AGENTS.md golden rule 4 uses the same policy phrasing as CLAUDE.md (no residual "never merges" absolute that denies operator merge surfaces).
- [ ] Living `pipeline-state-machine` requirement no longer claims "no merge command anywhere in the orchestrator or stage handlers"; it states no merge stage in `STAGES` and no merge call reachable from `pipeline advance`.
- [ ] The structural-guarantee carve-out names both `pipeline merge` and `merge-queue --apply` as explicit operator merge surfaces, and still states they are never called by the advance loop.
- [ ] `auto_merge` remains absent from `PartialConfigSchema` and still produces a strict-schema parse error identifying `auto_merge` as an unknown key (existing scenario retained).
- [ ] README purpose summary no longer implies "you alone own a manual GitHub merge button with no pipeline merge tooling"; it states autonomy through ready-to-deploy and merge only under explicit session-bound operator authority.
- [ ] `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` product boundary and "What this skill never does" sections acknowledge operator-invoked merge surfaces (including merge-queue `--apply`) and forbid autonomous/unattended merge — they do not claim merge-queue is dry-run-only forever.
- [ ] Structural isolation tests still pass: advance stage handlers do not call merge-queue; `mergePr` remains unreachable from the advance loop path; no new `auto_merge` config key is introduced.
- [ ] Diff is docs/spec/test-guard only (no merge-handler or stage-handler behavior change); `plugin/` mirror regenerated if hosts skill copy is mirrored; `npm run ci` green.

## Capabilities

### New Capabilities

<!-- none — this change reconciles existing policy language; it does not introduce a new product capability -->

### Modified Capabilities

- `pipeline-state-machine`: Correct the structural never-autonomous-merge guarantee and operator-invoked merge carve-out (name `merge-queue --apply`; remove the false "no merge command anywhere" claim).
- `merge-queue-command`: Align the loop-isolation / human-owned-authority requirement with shipped `--apply` drive (no longer "future" drive only).
- `readme-user-clarity`: Require public README positioning to name the autonomy boundary precisely (through ready-to-deploy; operator-authorized merge; no autonomous deployment / end-to-end SDLC claim).

## Impact

- **Docs / conventions:** `CLAUDE.md`, `AGENTS.md`, `README.md`, `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` (and generated `plugin/` mirror of host skill packaging where applicable).
- **Living specs:** `openspec/specs/pipeline-state-machine/spec.md`, `openspec/specs/merge-queue-command/spec.md`, `openspec/specs/readme-user-clarity/spec.md` (via archive of this change).
- **Tests (guards only, no behavior change):** existing loop-isolation / `auto_merge` rejection tests retained; strengthen or add a drift-guard that `mergePr` is not reachable from the advance loop if the current suite does not already assert that precisely enough for the reworded policy.
- **Out of scope:** any new merge automation or authority expansion (#662 unattended merge); merge-queue functional changes / conflict-CI repair (#675); runtime stage or CLI behavior changes.
