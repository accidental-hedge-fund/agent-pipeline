## Context

The pipeline is fully autonomous by default: once an issue carries `pipeline:ready`, it advances end-to-end to `ready-to-deploy` without any human touch. Teams adopting the pipeline gradually want narrower initial autonomy — e.g. "plan for me, but I'll approve before you write code." No mechanism for that pause exists today.

The maintainer decision (2026-06-10) scopes this to labels + comments only: no durable approval-record store; the `awaiting-approval` label is the sole gate; the checkpoint comment binds the HEAD SHA (reusing the reviewed-sha staleness pattern from `review-sha-gating`). Approval = label removal + re-invoke; mirrors `--unblock`.

## Goals / Non-Goals

**Goals:**
- A single config key (`approval_checkpoints`) that declares which stages require human approval before the pipeline dispatches them.
- Checkpoint posting: a PR comment with an embedded SHA sentinel + `pipeline:awaiting-approval` label → advance loop exits `waiting`.
- Staleness detection: if the branch HEAD advances while the checkpoint label is still present, re-issue the checkpoint against the new SHA.
- Clean approval flow: human removes the `awaiting-approval` label → re-invoke → pipeline proceeds through the checkpoint stage normally.
- Default `[]` preserves current fully-autonomous behavior exactly.

**Non-Goals:**
- Multi-approver quorums or role-based approval (one label removal = one approval).
- A durable approval-record store or event log.
- An `--approve` CLI flag (label removal is the approval mechanism).
- Checkpoints inside stage handlers (e.g. mid-plan or mid-fix pauses).
- Changing the merge gate, review layer, or eval gate.

## Decisions

### Decision 1: Checkpoint check lives in the advance loop, not in stage handlers

The advance loop in `pipeline.ts` checks whether the stage it is about to dispatch is listed in `approval_checkpoints`, BEFORE calling the stage handler. This centralizes checkpoint logic in one place and prevents it from leaking into every stage file.

**Alternative considered:** inject a `checkApproval()` call at the top of each relevant stage handler. Rejected: scatters approval logic across N files; easily missed when adding new stages.

### Decision 2: Stage names as checkpoint identifiers

`approval_checkpoints` is an array of stage names from `STAGES` (e.g. `["implementing", "pre-merge"]`). A checkpoint means: "require human approval before dispatching this stage." Config validation (zod) rejects any name not in `STAGES` and rejects `backlog` and `ready-to-deploy` (first and terminal stages — pausing before them is meaningless).

**Alternative considered:** boundary-label strings like `"post-plan-review"`. Rejected: requires a mapping layer; stage names are already the canonical identifiers; simpler for users to reason about.

### Decision 3: `pipeline:awaiting-approval` label as the gate signal

A new label `pipeline:awaiting-approval` signals a pending checkpoint. The advance loop reads the current issue labels at the top of each run; if this label is present when the loop reaches the checkpoint stage, it validates the SHA (see Decision 4) and exits `waiting`. If absent, the checkpoint is cleared (approved) and the stage dispatches normally.

This mirrors the `blocked` label pattern exactly: `blocked` → `pipeline:awaiting-approval`; `--unblock` → label removal.

**Alternative considered:** A separate "approved" comment trigger (human posts a magic comment). Rejected: harder to automate and harder to observe; labels are already the canonical state surface.

### Decision 4: SHA binding via HTML comment sentinel `<!-- checkpoint-sha: <sha> -->`

When the pipeline issues a checkpoint, it embeds the current HEAD SHA in the comment body as `<!-- checkpoint-sha: <full-sha> -->`. On subsequent runs where the `awaiting-approval` label is still present, the pipeline reads this sentinel:

- SHA matches HEAD → checkpoint still valid, stay `waiting`.
- SHA does not match HEAD (branch advanced) → re-issue the checkpoint comment against the new SHA (with a brief notice), keep the label, stay `waiting`.
- No checkpoint comment found → treat as missing, re-issue.

This reuses the same pattern as `<!-- reviewed-sha: <sha> -->` in `review-sha-gating`, so the staleness-check code is structurally identical.

**Alternative considered:** no SHA binding (approve once, valid forever). Rejected: if code is pushed after a checkpoint was posted, the human would be approving work they haven't seen; the SHA check catches this.

### Decision 5: Checkpoint comment header

The posted comment uses the header `## Pipeline: Awaiting Approval` (consistent with `## Pipeline: Blocked`, `## Pipeline: Review ceiling reached`). It includes the stage name, the short SHA, the full SHA sentinel, and the resume instructions (remove `pipeline:awaiting-approval` label, then re-invoke).

## Risks / Trade-offs

- **Label-only approval is coarse-grained** → Anyone with write access to the repo can approve by removing the label. For most teams this is fine; multi-approver workflows are explicitly out of scope.
- **SHA staleness re-issues the checkpoint** → If CI commits or bots push to the branch while a checkpoint is pending, the human must re-approve. Mitigation: internal commits (`isPipelineInternalCommit`) do not change the substantive code, so the pipeline SHOULD suppress re-issue for those. Mark as a follow-up — initial implementation re-issues on ANY SHA change; an `isPipelineInternalCommit` filter can be added later if it proves disruptive.
- **`awaiting-approval` label persists if the pipeline crashes mid-issue** → Same risk as the `blocked` label; operators already know to clean up labels manually in that case.
- **Config validation is the only guard against unsupported stage names** → If a user typos a stage name (e.g. `"implmenting"`), zod catches it at config load time and fails fast. No runtime surprise.

## Migration Plan

Fully additive. No changes to `.github/pipeline.yml` files that don't set `approval_checkpoints`. Default value `[]`. No label changes to existing issues. Rollout = merge the PR; no migration steps needed.

To enable: add `approval_checkpoints: ["implementing"]` (or any valid stage names) to `.github/pipeline.yml`.
