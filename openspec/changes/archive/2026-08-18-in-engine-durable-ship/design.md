## Context

See `proposal.md` for motivation.

Living specs disagree with this issue. Do not blend them.

| Source | Says | This change does |
|---|---|---|
| `ship-coordinator`, `scoped-autonomous-factory-operations`, golden-rule 4 | `pipeline ship` requires `--authorization` + `--for` and a signed grant | Follow #1096. Operator product is `pipeline ship --milestone vX.Y.Z`. Grant path is not revived as the operator surface. |
| `tugboat-thin-ship`, closed #1001 | Phrase → Tugboat. Tugboat MUST NOT call `pipeline ship`. “Never in-engine ship.” | Follow #1096. Tugboat is not the owner. Phrase → `pipeline ship --milestone`. Notify/detach MAY stay as a thin adapter. |
| `integrated-train-mode` numbered merge-mode list | Per frontier: advance wave, then merge wave | Follow #1096 / closed #1063. Already-R2D + MERGEABLE items merge and base-contain **before** any plan/implement mutation. Train.ts “merge-first” is a log line today. |
| `loop-live-advance-coexistence` | Stale crash store is not live; genuine crash without a live holder stays `workflow-engine-defect` | Follow #1096. Mid-stage kill / power-loss with a **dead** holder is resume of the same item, not `workflow-engine-defect` and not `coexistence_wait` on the corpse. |
| Human comment 2026-08-18 | #1114 / #1115 are v1.39.3 patches; do not wait on this epic | Orthogonal. This change does not include or block those patches. |

Current `pipeline ship` in `core/scripts/pipeline.ts` still requires `--for` and `--authorization`. Current `train --merge` advances a frontier then merges. Current supervisor reuse of a dead loop (`loop-cd7bd53d94838204` on 2026-08-16) classified harness-failure as `workflow-engine-defect`, burned `restart_workflow_engine`, then `coexistence_wait` ×6 to `supervisor_no_progress`.

Constraints:

- Class over site. Shared classifier / recipe / gate / controller law. No #1095-only or #1037-only mole.
- Advance / single / loop never merge. Ship composes `train --merge` and existing merge gates.
- No grant factory, MessagingPort, or second durable scheduler.
- Unit tests inject deps. No real network, git, or subprocess.

## Goals / Non-Goals

**Goals:**

- One in-engine ship command that is resume-safe, merge-first, and recoverable for non-human classes.
- Hosts stay phrase → CLI. Hermes re-invokes the same command. Engine owns classification and merge order.
- Train `--merge` actually merge-firsts, so ship has no second merge policy.
- Interrupt with a dead holder resumes the same ledger item.

**Non-Goals:**

- Implementing grant/Ed25519 admission, or deleting the parked grant types if unused code can stay uninvoked.
- Replacing Tugboat notify/detach helpers if they remain thin readers of the Pipeline ledger.
- Continuous `ship.model` (#1024).
- #1114 CLI positional cap and #1115 post-merge FRG-then-tag (sibling 1.39.3 patches).
- Auto-merge from advance/loop.
- Finishing the v1.39.2 FRG train.

## Decisions

### D1 — Operator surface is milestone-only `pipeline ship`

**Decision:** The operator product argv is `pipeline ship --milestone vX.Y.Z`. Version MAY be derived from the milestone title when it is a `vX.Y.Z` / `X.Y.Z` label. A documented alias is allowed only if it is the same command. `--authorization` and a signed grant MUST NOT be required. `--for` MUST NOT be required when the milestone already names the version.

**Rationale:** #1096 names that argv. The grant path is explicitly not this feature. Requiring `--for` plus a grant JSON is the parked Buzz-admission surface.

**Alternatives considered:**

- Keep `--authorization` required and add a host that writes a dummy grant → rejected. That revives the grant path as the operator surface.
- Add `pipeline ship-milestone` as a second verb → rejected. The product is `pipeline ship`.
- Keep `--for` required beside `--milestone` → rejected for the operator phrase `Ship milestone vX.Y.Z`. Version is already in the milestone name.

### D2 — Operator invocation is the ship authority

**Decision:** Invoking `pipeline ship --milestone` is loop-isolated operator authority, the same class as `pipeline train --merge` and `pipeline merge`. Repository config still cannot authorize merges. Advance/single/loop still never call ship.

**Rationale:** Golden-rule 4 already allows loop-isolated operator merge surfaces. The conflict is only the extra grant document. #1096 removes that document from the operator path.

**Alternatives considered:**

- Session-bound confirmation prompt inside ship → rejected. Hosts must exec the CLI; a second human gate would recreate Tugboat waits.
- Keep grant verification when `--authorization` is passed, and make it optional → allowed only as a parked unused path. It MUST NOT be the documented operator surface and MUST NOT be required.

### D3 — One ship ledger; GitHub remains source of truth

**Decision:** Persist one typed ship record keyed by repository, base, and milestone (version when distinct). The record is a restart checkpoint: phase, current item, child train/loop/release identities, last durable stage, terminal result, human-authority flag. Before every mutation, re-observe GitHub labels/PRs/base and the worktree. A completed side effect advances the checkpoint. A second invoke of the same key continues that record.

**Rationale:** Existing `ship-coordinator` already requires an atomic restart-safe record. The 2026-08-16 farm happened because train started a sibling implement while an R2D PR stayed open. The ledger plus merge-first must make that a failed invariant, not a log line.

**Alternatives considered:**

- Host-local Tugboat `ship-vX.Y.Z/state.json` as the ledger → rejected. Hosts read the Pipeline ledger.
- Reuse only the loop run directory as the ship ledger → rejected. The live bug reused `loop-cd7bd53d94838204` after SIGTERM and then treated the corpse as live.

### D4 — Merge-first lives in `train --merge`, not a ship-local merge policy

**Decision:** Before any plan/implement mutation, `train --merge` MUST merge every work-list item that is already `pipeline:ready-to-deploy` with an open mergeable PR and prove base containment. Only then may it advance a non-R2D sibling. Ship fails if that prelude is skipped. Ship does not call `mergePr` itself except by composing the existing train/merge surfaces.

**Rationale:** #1096: no second merge policy. Closed #1063 claimed this. The living train list is advance-then-merge, which is the PR farm.

**Alternatives considered:**

- Ship walks R2D PRs and calls `pipeline merge` before `train --merge` → rejected as a second merge policy that can drift from train.
- Keep advance-then-merge and only document merge-first → rejected. That is today’s log line.

### D5 — Dead holder is takeover; interrupt is not `workflow-engine-defect`

**Decision:** A mid-stage kill, crash, SIGTERM, host reboot, or network drop whose prior holder is **dead** is a resume-eligible interrupt. Classifier MUST NOT project it to `workflow-engine-defect`. Recovery MUST NOT claim `restart_workflow_engine` first. Coexistence probe MUST NOT treat a dead PID / stale lock / stale loop run as a live holder. Supervisor MUST take over the same item (worktree + labels + ledger) and MUST NOT cycle `coexistence_wait` into `supervisor_no_progress`. A **live** holder remains coexistence wait.

**Rationale:** Live 2026-08-16T19:27Z is the fixture. Power-outage must resume #N. `implementing-resume` already knows how to resume or restart a stranded implement; the supervisor never reached it.

**Alternatives considered:**

- Keep harness-failure → `workflow-engine-defect` and add more `restart_workflow_engine` budget → rejected. That burns the class and still waits on the corpse.
- Host deletes the run dir and starts a new loop → rejected. Hermes does not janitor. Engine resumes the ledger item.

### D6 — Hosts are phrase → CLI; Hermes only re-invokes

**Decision:** Every listed host SKILL maps `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z`. Detach only if the CLI is blocking. Status/stop read `pipeline ship status`. Notify on ledger phase/item/terminal using exact child-run identities (existing notify law). On a non-human failure notify, Hermes re-invokes the same argv. If the ledger says human authority, the host stops and reports that. Hosts do not classify, delete run dirs, wait a cooldown, or invent `single`/`loop`.

**Rationale:** #1096 items 6–7. Tugboat-as-owner is superseded.

**Alternatives considered:**

- Keep Tugboat as the Buzz default and have it call `pipeline ship` → extra hop. Allowed only as a thin detach wrapper that does not own state. Docs MUST still name `pipeline ship` as the product.
- Hermes classifies leftover `blocked` / `implementation-ci` → rejected. That is the second brain.

### D7 — #1095 is composed, not reimplemented

**Decision:** Ship / train consume the already-landed recovered-block classification (`loop_item_blocked` then later ready terminal + live R2D → merge). This change adds the merge-first prelude and the “do not farm a sibling while that PR is open” ship invariant. It does not invent a parallel leftover-block classifier.

**Rationale:** Issue depends on #1095. Class over site: leftover block is already shared train law.

## Risks / Trade-offs

- [Parked grant CLI still exists] → Operator docs, skill argv, and CLI help MUST present milestone-only ship. Tests MUST accept `pipeline ship --milestone vX.Y.Z` without `--authorization`. Optional leftover grant flags MUST NOT be required.
- [Merge-first delays independent ready siblings] → Accepted. Farmed implements while an R2D PR is open is the defect. Independent R2D siblings still merge serially in the prelude.
- [Interrupt vs genuine harness defect] → A **live** holder or a repeated same-fingerprint crash after a successful resume attempt may still be `workflow-engine-defect`. Only dead-holder interrupt is resume-eligible without that class.
- [Tugboat thinness tests forbid `pipeline ship `] → Update those tests so Tugboat-as-owner is forbidden, not the in-engine product command in skills/docs.
- [Version derivation from milestone title] → If a milestone title is not a semver, ship fails closed and asks for an explicit version flag rather than guessing.

## Migration Plan

1. Land merge-first + dead-holder resume + leftover-block composition in train/loop (class law) with fixtures that fail on the 2026-08-16 sequences.
2. Land milestone-only `pipeline ship` + ledger resume. Keep parked grant flags uninvoked if present.
3. Point host skills and ship runbook at `pipeline ship --milestone`. Update #1001/#971 doctrine sentences.
4. Operator ships with `pipeline ship --milestone vX.Y.Z`. Do not train this change on the v1.39.2 FRG milestone.

Rollback: revert the change. Old Tugboat phrase mapping and grant-required `pipeline ship` return. Do not leave half-updated skills that still forbid in-engine ship while the CLI is milestone-only.

## Open Questions

- None that block specs or tasks. Ledger file path (repo `.agent-pipeline/` vs factory-control checkout) can follow the existing ship-coordinator record location at implement time.
