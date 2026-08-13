## Why

When an engine self-block stalls a live train item, the durable engine fix must land in **this** pending release as a **sibling issue**, while the blocked (victim) item continues to `pipeline:ready-to-deploy` without absorbing engine-source patches. Papercut / correction / durable-run-blocker auto-file is `pipeline:backlog` only and never assigns a milestone (#538). Loop excludes backlog from advance, so a backlog-only engine fix misses the current train. Live dogfood: v1.38.0 train STOP on #1013; sibling **#1017** had to be filed and milestone-attached by hand. Epic **#1028** seeded living `engine-class-live-sibling` and a first-cut implementation; this change locks the **full #1021 contract** as the narrow #538 exception: in-run, first-occurrence, current-train-milestone, `pipeline:ready` sibling after #1020-class recover.

## What Changes

- After first successful **engine-class / engine-scratch recover** (`workflow-engine-defect` path recovered by #1020's recipe, e.g. `unlink_engine_scratch`), file **at most one** live sibling issue keyed by stable `evidence_key`.
- Sibling labels: `bug` + `pipeline:engine-class` (or stable engine-class marker) + `pipeline:ready`. **Not** `pipeline:backlog`. **Not** papercut.
- Milestone = current train milestone when in scope (`pipeline train --milestone` / ship playbook / first-class train·loop context from #1023 when present). If none is in scope, file **without** a milestone — do not guess.
- Sibling body declares machine-usable `Depends on: #<recovered-item>` so train orders the sibling after the victim.
- Reuse the existing **cross-host-safe** auto-file pattern: pre-create GitHub-state dedup + rate-cap, post-create reconciliation. Rate-cap membership is **marker-scoped** and independent of papercut / correction / durable-run-blocker budgets.
- Filing is **non-fatal** relative to recover: sibling create failure must not reverse recover success, re-block the victim, or STOP train solely for that failure.
- Product-class review findings, design / credential holds, dirty product (`core/`, dirty product `openspec/`), and `human-decision-required` **never** trigger a live sibling and never assign a milestone for those non-triggers.
- Never auto-merge. Never `--override`. Never reverse #538 for papercuts, corrections, or durable-run-blockers.

## Capabilities

### New Capabilities

- (none) — capability `engine-class-live-sibling` already exists from epic #1028; this change strengthens it.

### Modified Capabilities

- `engine-class-live-sibling`: Lock the full #1021 contract — recover-only trigger, one open sibling per `evidence_key` in-window, ready + engine-class labels, train-milestone assignment fail-closed, `Depends on` the recovered item, independent marker-scoped rate-cap, non-fatal relative to recover, no file on human-decision / product dirt, no reversal of #538 backlog-only auto-file.

## Acceptance criteria

- [ ] Replay of #1013 class: after engine-scratch / workflow-engine-defect recover, the original item continues toward ready-to-deploy; exactly one sibling is filed when a train milestone is in scope; sibling body declares `Depends on: #<original>`; train does not STOP solely because recover cleared a mechanical `blocked` or because the sibling was filed.
- [ ] Second identical `evidence_key` inside the auto-file window does not create a duplicate open sibling (pre-create dedup and/or post-create reconcile to lowest-numbered survivors).
- [ ] `human-decision-required` and dirty product (`core/` or equivalent product porcelain) do not file a live sibling and do not assign a milestone for that non-trigger.
- [ ] Sibling labels are `bug` + `pipeline:engine-class` + `pipeline:ready` and never `pipeline:backlog`; papercut / correction / durable-run-blocker auto-file remains backlog-only with no stage-advance labels.
- [ ] When no train milestone is in scope, sibling may still be created without a milestone; the engine does not invent a milestone title or pick an unrelated open milestone.
- [ ] Sibling filing failure does not reverse a successful recover (victim stays unblocked on the recover path).
- [ ] Unit tests inject deps (no real network, git, or subprocess) for file, dedup, rate-cap, labels, Depends on, and milestone fail-closed.
- [ ] After any `core/` edits, `plugin/` is regenerated; `openspec validate file-engine-class-live-sibling` and `npm run ci` pass.

## Impact

- `core/scripts/stages/engine-class-live-sibling.ts` — filing, body/title, labels, marker, train-milestone context, cross-host dedup/rate-cap reconcile.
- Recover coupling: successful `unlink_engine_scratch` (and any equivalent first-class engine-class recover hook) best-effort invokes live sibling file; failure is non-fatal.
- Train / CLI: expose current train milestone into filing context when `pipeline train --milestone` (or ship playbook) runs; clear context when the train invocation ends.
- Config: may reuse numeric window/max knobs from existing auto-file defaults, but rate-cap **membership** stays marker-scoped and independent of other auto-file categories (#631).
- Tests: `core/test/engine-class-live-sibling.test.ts` and recover-path coupling tests with injectable deps.
- Generated `plugin/` mirror after any `core/` edit.
- Depends on: **#1020** (hard). Prefer **#1023** for first-class train-milestone seam; not a hard gate if explicit milestone argument / train context is enough.
- Program: ship-path autonomy epic **#1028**; composition/FRG **#1029**.
