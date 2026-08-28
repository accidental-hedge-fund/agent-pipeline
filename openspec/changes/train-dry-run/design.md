## Context

See `proposal.md` for why. Current law and code:

- `COMMAND_REGISTRY.train.allowedFlags` includes `dryRun`. The CLI usage-error `Allowed:` list names `--dry-run`.
- `runTrainCommand` then returns 2 with `pipeline train: --dry-run is not supported for train; omit it.`
- `runTrain` already resolves snapshots, filters backlog, orders issues, and logs `[train] ordered issues: #A → #B` **before** `initTrainRunStore` / `advanceWave` / merge.
- Live `--json` stdout is exactly one `train_status` object (`schema_version: 1`). Ship playbook completion keys on `kind: "train_status"` with `complete: true`.
- Train events (`train-event-stream`) mint `.agent-pipeline/runs/train-*/events.jsonl` on live admission. `train --dry-run` was explicitly out of that change.
- Peer commands (`merge-queue`, `decompose`, `sweep`, `intake`, `roadmap`) preview by default or support `--dry-run`. `merge-queue` is dry-run by default. Train must **not** copy that default: Tugboat / `pipeline ship --milestone` invoke live `train --merge`.

Locked issue decisions: support `--dry-run` in normal and `--merge` modes; structured point-in-time read-only plan; may read config and GitHub; must not invoke an engine, create a worktree, post a comment, push, or merge; JSON is the machine-readable plan contract shared with train event work without coupling implementations.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is train's handler rejecting an allowlisted flag. The class is: a command-registry `allowedFlags` entry is a contract the handler must honor, and an operator-authorized merge surface must offer a read-only preview.
2. **Shared surfaces.** Train flag allowlist + handler; a `train_plan` JSON object that reuses `ordered_issues` / `merge_mode` / per-item `issue` / `pr` from `train_status` and `train_work_list_resolved`; existing pure order/frontier helpers. Not a second train orchestrator and not a call into the live event writer.
3. **Next identical fault.** The next advertised-but-rejected flag fails the allowlist/handler drift test. The next merge-capable operator command can emit a plan object that supervisors already know how to read. No new mole issue for "I tried `--dry-run` and the error lied."

## Goals / Non-Goals

**Goals:**

- Honor `--dry-run` on `pipeline train` in default and `--merge` modes.
- Print a snapshot plan (human + JSON) using the same order live train would use now.
- Keep live train, live `train_status`, and ship-playbook completion unchanged.
- Keep dry-run off the train run store and off every mutating seam.

**Non-Goals:**

- Making dry-run the default.
- Proving merge-result containment (git fetch / ancestry) in the plan.
- Changing merge-first, frontier, recovery, or independent-sibling merge law.
- Writing `events.jsonl` or `train_run_handoff` for a preview.
- A generic allowlist-vs-handler framework for every command (this change ships the train instance and a biting train regression).
- Merge from advance/loop; `auto_merge`; a grant file.

## Decisions

### 1. Implement the flag; do not drop it from the allowlist

**Choice:** Keep `dryRun` in `train.allowedFlags` and implement the plan. Do not remove `--dry-run` from the `Allowed:` string.

**Why:** The issue's useful fix is a rehearsal before `train --merge`. Dropping the flag would make the error consistent and still leave the highest-consequence merge surface without a preview.

**Alternatives considered:**

- Remove `dryRun` from the allowlist → consistent, but operators still cannot preview a merging train.
- Default to dry-run like merge-queue → **BREAKING** for `pipeline ship` / Tugboat, which invoke live `train --merge`.

### 2. Opt-in preview; live train remains the default

**Choice:** `--dry-run` is required for the plan. No `--apply` pair. Omitting the flag runs today's executor.

**Why:** Train is an executor, not a planner-by-default. Merge-queue inverts that because its only original product was a plan.

**Alternatives considered:**

- `--apply` to go live, dry-run default → breaks ship/Tugboat argv.

### 3. Stop after the existing pre-mutation snapshot, plus GitHub PR/stage reads

**Choice:** Reuse the current `runTrain` prefix: parse selector, load snapshots, drop backlog, `orderIssuesForTrain`, compute merge-first. Then read linked PR state (open and any-state) and current stage. Print/return the plan and return 0. Do not call `initTrainRunStore`, `advanceWave`, `recoverParked`, or `mergeIssuePr`.

**Why:** The issue already notes that the ordering line is most of the plan. Sharing the pure helpers keeps dry-run order identical to live order without copying the mutation loop.

**Alternatives considered:**

- Run live train with every mutating dep stubbed → easy to leak a write; rejected.
- Duplicate ordering in the CLI handler → drift from `orderIssuesForTrain`.

### 4. JSON `kind` is `train_plan`; field names overlap `train_status` / events

**Choice:** `--json --dry-run` stdout is exactly one unfenced object:

```json
{
  "schema_version": 1,
  "kind": "train_plan",
  "merge_mode": false,
  "ordered_issues": [10, 11],
  "merge_first": [],
  "items": [
    {
      "issue": 10,
      "stage": "ready",
      "pr": null,
      "intended_action": "would-advance"
    }
  ]
}
```

Overlapping facts use the live names (`ordered_issues`, `merge_mode`, item `issue` / `pr`). `kind` is `train_plan`, not `train_status`. Dry-run builds this object in the planner; it does not call `appendEvent` or `initTrainRunStore`. Live train does not import the planner to mutate.

**Why:** Ship playbook and supervisors select `kind: "train_status"` with `complete: true`. Reusing `train_status` would risk a false complete or a false fail. Shared field names are the contract with train event work; separate builders are the decoupling.

**Alternatives considered:**

- Emit `train_status` with `complete: false` → ship playbook fail-closed is safe, but a naive `complete: true` preview would false-complete a shipment.
- Emit `train_work_list_resolved` onto stdout → couples preview to the event catalog and breaks "one JSON object" / `train_status` law for live JSON.
- Write the plan through the event writer into a throwaway run dir → forbidden local run-store write; dry-run is not a run.

### 5. Intended actions are a closed snapshot set; no containment proof

**Choice:** Classify each item from GitHub labels + linked PR state + in-list declared code deps:

| `intended_action` | When |
| --- | --- |
| `would-merge` | `--merge`, current stage is ready-to-deploy, open linked PR |
| `already-integrated` | `--merge`, ready-to-deploy, linked PR is merged (GitHub state only) |
| `would-block` | `--merge`, ready-to-deploy, no linked open or merged PR |
| `would-advance` | not ready-to-deploy, snapshot-frontier eligible, not held |
| `waiting-on-deps` | in-list code prereq is not `already-integrated` on this snapshot |
| `held` | `pipeline:needs-human` or `blocked` |

`merge_first` is the current ready-to-deploy open-PR set in train order. Frontier eligibility approximates live `computeBaseEligibleFrontier` by treating GitHub-merged ready-to-deploy items as integrated. Dry-run SHALL NOT `fetchBase` or prove ancestry.

**Why:** Containment is a live merge-mode proof. Fetching origin is extra git I/O and is not needed to answer "what would this train try to do right now."

**Alternatives considered:**

- Call `reconcileMergedPrIntegration` (fetch + ancestry) → useful, but it is the live integrate path and can mutate local refs via fetch. Out of the locked read set (config + GitHub).
- Omit `already-integrated` and always `would-merge` → lies about closed+merged freeze members.

### 6. Human output keeps the existing ordered-issues line

**Choice:** Print the current `[train] ordered issues: #A → #B (merge mode… | advance only…)` line, then one row per item (stage, PR, frontier, intended action), then a footer that no mutations ran.

**Why:** Operators already know that line. The extra rows are the gap vs live start.

**Alternatives considered:**

- JSON-only dry-run → fails the issue's "preview before a multi-hour run" for humans without `--json`.

### 7. Registry docs usage lists `--dry-run`; handler drift is tested

**Choice:** Update train documentation metadata usage to `train --milestone <m>\|--issues <n,n> [--merge] [--json] [--dry-run]`. Add an injected test that fails if `allowedFlags` contains `dryRun` and the handler still returns the unsupported-flag error.

**Why:** The bug is allowlist/handler split-brain. The test is the class fix for this surface.

**Alternatives considered:**

- A generic scan of every command's allowedFlags vs handler → larger than this issue; not required to close #1275.

## Risks / Trade-offs

- **[Risk] Snapshot drift before a live run.** Stages and PRs can change. → Mitigation: spec the plan as point-in-time; do not persist it as authorization.
- **[Risk] `already-integrated` without containment.** A merged PR might not be in the fetched base yet. → Mitigation: name the class `already-integrated` from GitHub merge state only; live train still proves containment.
- **[Risk] Ship playbook false-complete if `kind` is wrong.** → Mitigation: `train_plan` is a distinct kind; add a scenario that stdout is not `train_status`.
- **[Risk] Dry-run accidentally inits the run store** because that currently sits immediately after the order log. → Mitigation: branch to plan return **before** `initTrainRunStore`; test asserts no run dir.
- **[Trade-off] No git fetch in dry-run.** Operators do not see containment failures in the preview. They still see would-merge vs already-merged vs would-block.

## Migration Plan

- Additive. Existing live argv is unchanged.
- CLI docs regenerate from command-docs usage (`docs/cli.md`, host SKILL tables).
- Rollback: revert the change; `--dry-run` is rejected again.

## Open Questions

None. The issue decisions lock support, plan contents, read-only bounds, and JSON-as-shared-contract.
