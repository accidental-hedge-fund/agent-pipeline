---
name: pipeline
description: |
  Use this skill whenever the user wants to advance a GitHub issue or PR
  through a label-driven dev pipeline toward `pipeline:ready-to-deploy`,
  or to run an operator-authorized train or ship. Triggers include
  "pipeline issue 419", "push #360 forward", "advance this PR through
  review", "run the pipeline on <issue>", and "Ship milestone vX.Y.Z".
  Do NOT use this skill for general PR review or backlog triage/cleanup.
  Ordinary advance, single, and loop never merge or deploy; merge,
  merge-queue --apply, train --merge, and ship are explicit
  operator-authorized surfaces.
---

# pipeline

Host SKILL for the `pipeline` CLI. Execute catalog operations as `pipeline <verb>`.

Default numeric drive (outside the verb table): `pipeline <N>` starts the durable
one-item drive for issue or PR N, the same lifecycle as `pipeline single <N>`.
`pipeline <N>` yields `loop_run_id`. Capture `run_id` from the durable loop
handoff as `loop_run_id`. Follow `pipeline loop logs <loop-run-id> --events --follow`.
After `loop_item_advance_linked` publishes `pipeline_run_id`, retain that value
as `advance_run_id` and also follow `pipeline logs <advance-run-id> --events --follow`.
`pipeline status <N>` reports issue metadata (stage, blocker, PR). It does not
discover a run id.

## Operations

```
pipeline status <n>                                 Read-only — print stage, blocker, PR, last review
pipeline unblock <n> "<answer>"                     Post an answer and clear the blocked label
pipeline override <n> "<key>: <reason>"             Operator-supplied or explicitly approved exact disposition ("<key>: <reason>"); auto-resumes. Not an autonomous host next action
pipeline recover-parked <n> [--json] [--dry-run]    One supervisor pass for a parked issue: deterministic recover first (including publish of an unpublished stage commit), then reflow only stale/DNR/below-high residuals (never auto-override HIGH/CRITICAL/security); pre-PR engine parks re-enter without a linked PR; re-enter single if clear
pipeline summary <issue-number|run-id>              Print the run evidence bundle for an issue number or exact run-id
pipeline doctor [--json|--is-ok] [--fail-fast] [--harness-smoke] Deterministic preflight check; print summary, exit 0/1. Reports continuous liveness as configured/available/active/degraded/unavailable without treating absence as human authority. Opt-in --harness-smoke adds one cheap model call per unique configured harness treatment
pipeline liveness status [--json] | pipeline liveness restore [--json] [--run-id <id>] Discover, claim, and reattach machine-local durable supervisors after worker or machine restart (not recovery or merge)
pipeline init                                       Ensure pipeline labels and scaffold .github/pipeline.yml
pipeline cleanup                                    Sweep merged-PR worktrees and delete their local branches
pipeline intake --description "<text>" [--release vX.Y.Z] [--dry-run] Spec a rough description into a GitHub issue and ROADMAP PR
pipeline decompose --epic <N> [--description "…"] [--apply] [--release vX.Y.Z] [--max-children N] [--max-effort S|M|L|XL] [--allow-xl] Break an epic issue into dependency-linked child issues and a ROADMAP PR (dry-run default; --apply writes; not intake / not roadmap-order-only / not loop-execute)
pipeline sweep [--apply] [--repo owner/name]        Batch re-spec thin issues and reconcile ROADMAP.md
pipeline grill --issue N [--dry-run] [--json] | pipeline grill --issues N,N,... [--dry-run] [--json] | pipeline grill --milestone M [--dry-run] [--json] | pipeline grill --label L [--label L] [--dry-run] [--json] | pipeline grill status --run-id <id> [--follow] [--json] | pipeline grill --resume <run-id> Native grill-with-docs admission: freeze a selector, auto-settle in-scope recommendations, write Decisions and domain docs, request pipeline:ready
pipeline triage <n> --stage ready|backlog           Set a pre-pipeline stage label (ready or backlog) on an issue. needs-spec is an admission hold: apply the spec, then triage --stage ready.
pipeline merge <pr>                                 Operator-authorized squash merge of a ready-to-deploy PR (never called by the advance loop)
pipeline merge-queue --milestone <m> [--apply] [--release-when-complete --release-version <ver>] Operator-authorized sequential merge of ready-to-deploy PRs; dry-run by default; optional prepare-only release-when-complete
pipeline train --milestone <m> [--merge] [--json] [--dry-run] | pipeline train --issues <n,n> [--merge] [--json] [--dry-run] Operator-authorized integrate train: base-eligible frontiers advance via one loop wave each (recovery inside the wave); optionally serial-merge with base containment; parks stay RecoverySupervisor-owned (recover-parked remains an operator CLI); independent R2D siblings may merge while a peer is parked or cooling (never called by the advance loop)
pipeline ship --milestone vX.Y.Z [--json] | pipeline ship status --milestone vX.Y.Z [--json] Run or inspect one durable milestone shipment (train --merge, release, finish, promote). Operator product is pipeline ship --milestone vX.Y.Z; no grant file required.
pipeline release <version> [--theme "..."] [--dry-run|--json] [--no-edit] [--skip-frg] | pipeline release finish <pr> [--json] | pipeline release ensure-tag <X.Y.Z> <merge-oid> --packed-candidate <sha> Prepare a release PR from the matching GitHub milestone plan (or finish-merge one); finish never tags; ship-end ensure-tag creates vX.Y.Z from on-disk HMAC latest.json when FRG is gitignored; --dry-run reports milestone presence/open issues
pipeline roadmap [--apply] [--next <n>]             Analyze open backlog into a dependency-aware scored roadmap; under SemVer, dry-run lists full milestone reconciliation actions and --apply converges open issues to the reviewed manifest (fingerprint-gated)
pipeline logs [<run-id>] [--events] [-f] [--no-until-terminal] List or stream pipeline run logs (events --follow exits 0 on terminal run_complete)
pipeline loop --milestone <m> [--audit] [--follow] | pipeline loop --label <l> [--audit] [--follow] | pipeline loop --range a-b [--audit] [--follow] | pipeline loop --roadmap-slice <slice> [--audit] [--follow] | pipeline loop <N> [<N> ...] [--audit] [--follow] | pipeline loop --resume <run-id> [--audit] [--follow] Durable multi-item run — driven in-repo by the pipeline's own loop supervisor
```

## Follow / notify

Capture durable run ids from handoff and linkage. Do not infer them from
`pipeline status <N>`. `pipeline loop` drive and resume are long-running.
Do not treat them as seconds-only or as fire-and-forget.

1. Status pre-check: `pipeline status <N>`.
2. Launch default drive: `pipeline <N>` or `pipeline single <N>`. Retain
   `loop_run_id` from the durable handoff (`run_id`). `pipeline <N>` yields `loop_run_id`.
   Follow `pipeline loop logs <loop-run-id> --events --follow`. Multi-item
   `pipeline loop …` uses the same loop follow.
3. After `loop_item_advance_linked` publishes `pipeline_run_id`, retain that
   value as the linked `advance_run_id` and also follow
   `pipeline logs <advance-run-id> --events --follow`. Keep the loop follow
   active. On a later linkage or a terminal advance, stop or replace the prior
   advance follow. Do not guess an advance id before linkage.
4. Notify only material events through the active host row and the shared
   material filter (`scripts/material-filter.mjs`). See the CLI event
   reference rather than this one-pager for the complete kind inventory.
5. Reattach an interrupted follow with the same retained ids.
   Interrupted follow is non-terminal. Cancelled wait is not completion.
   A dead worker is not-live, not completion, and not human authority.
   Restore with `pipeline liveness restore`. Follow with `pipeline logs` /
   `pipeline loop logs --events --follow` (portable follow).
6. Advance `run_complete` stops or replaces only that advance follow.
   Keep the loop follow active while the loop remains live.
7. Stop the loop-scoped follow set on `loop_run_complete`,
   `loop_run_stopped`, or supervisor exit, in the same turn.
8. After a confirmed terminal loop outcome, emit a final summary with the
   terminal reason and confirmation that follows stopped. Mutating
   `pipeline <N>` uses that same loop-terminal contract rather than completing
   on a child advance `run_complete` alone.
9. Premature supervisor exit is non-terminal failure/recovery, never
    completion. Tear down every run-scoped follow, then invoke
    `pipeline liveness restore` or portable follow. Do not retry
    `pipeline single`, classify a recipe, or emit a completion summary.

The follower or observer never invokes a merge-capable command: `merge`,
`merge-queue --apply`, `train --merge`, or `ship`.

Residual review park at current HEAD: the host MAY run `pipeline recover-parked <N>`
at most once for the current park fingerprint. If the issue remains parked, STOP
in the same turn and notify a human. Never invent `pipeline override` or remove
`blocked` / `pipeline:needs-human`. Do not invoke `recover-parked` from inside
`pipeline train`.

### Host notify map

Select the row for the active host. Shared orchestration does not hard-require
another host's tools. Compact rows carry mapping fields only; portable
fallback stays in the outer-host manifest and durable docs.

| Host | Surface | Tools | Filter |
| --- | --- | --- | --- |
| claude | claude_monitor_push | Monitor, PushNotification | scripts/material-filter.mjs |
| codex | codex_chat_status | chat, status | scripts/material-filter.mjs |
| grok | grok_monitor_lines | monitor | scripts/material-filter.mjs |
| opencode | stdout_only | — | scripts/material-filter.mjs |

## Authority

Default `pipeline <N>`, `pipeline single`, and `pipeline loop` are autonomous
through `pipeline:ready-to-deploy` and never merge or deploy.

Operator-authorized, non-advance surfaces:

- `pipeline merge <pr>`
- `pipeline merge-queue --apply` (merge-queue is dry-run by default unless `--apply` is explicit)
- `pipeline train --merge`
- `pipeline ship --milestone`
- `pipeline override <n> "<key>: <reason>"` — operator-supplied or explicitly approved exact key and reason. The host must not invent that disposition.

`Ship milestone vX.Y.Z` maps to `pipeline ship --milestone vX.Y.Z`. No grant
file is required.

## Docs

- Packaging: https://github.com/accidental-hedge-fund/agent-pipeline/blob/main/docs/packaging.md
- CLI: https://github.com/accidental-hedge-fund/agent-pipeline/blob/main/docs/cli.md
