## Why

Dependent milestone work cannot safely start from a base that only knows a prerequisite reached `pipeline:ready-to-deploy`. Operators and thin supervisors need one explicit CLI train that advances each issue, merges it through the existing merge surface, proves the merge is in the configured base, then starts the next item — without a second durable control plane, grant schema, or outer factory product.

## What Changes

- Add an opt-in `pipeline train` command (or equivalent loop-isolated surface) that runs an ordered issue list or milestone as an **integrate train**.
- When `--merge` is set: for each item, advance to ready-to-deploy, invoke the existing `pipeline merge` path on the linked PR, prove squash-aware merge-result containment in `origin/<base>`, then admit the next item.
- Default `pipeline advance`, `pipeline single`, and non-train `pipeline loop` remain stop-at-ready-to-deploy and do not merge.
- Reuse existing dependency discovery, loop store, merge gates, and event streams. Do not add a second journal, macro-controller, grant schema, or `auto_merge` config key.
- Emit machine-readable train status/events suitable for a thin Buzz/Hermes notifier.
- Document the authority carve-out: train with `--merge` is loop-isolated and explicit, same class as `pipeline merge` / `merge-queue --apply`.

## Capabilities

### New Capabilities

- `integrated-train-mode`: Opt-in CLI train that orders work, advances items, optionally merges through the existing merge surface, enforces base-frontier containment between items, pauses on human blockers, and exposes train status/events.

### Modified Capabilities

- `merge-authority-boundary`: Recognize `pipeline train --merge` as an additional loop-isolated, operator-invoked merge orchestration surface (not advance-path merge, not repository `auto_merge`).
- `pipeline-state-machine`: Preserve advance-loop isolation; clarify that train is not a stage and does not add a merge stage to `STAGES`.
- `command-registry`: Register the `train` command with an explicit flag allowlist and docs metadata.
- `durable-run-dependency-integrity` / dependency release: Under train merge mode, ready-to-deploy alone MUST NOT release a same-train dependent; verified merge containment MUST.

## Impact

- CLI surface (`pipeline.ts`, command registry, host skill docs, generated CLI docs when present).
- New train orchestration module composing existing single/loop advance, merge, dep compile, and base observation — not a rewrite of the durable loop.
- Unit tests for ordering, containment, isolation from advance, pause/resume, and idempotent already-merged PRs.
- Operator docs: README, golden-rule wording, factory simplification plan cross-links.
- Downstream: thin Hermes adapter (Phase 2) and release finish (Phase 3) depend on this primitive; outer `ops/hermes-factory` is not extended.
