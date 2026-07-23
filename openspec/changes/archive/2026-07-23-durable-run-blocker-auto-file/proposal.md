# Auto-file issues for durable-run blockers via the improve clustering path

## Why

Durable `pipeline:loop` runs classify their blockers with a typed
`DurableBlockerClass` and a stable `evidence_fingerprint` (#509), and stop the
run with a typed `LoopStopRecord` when a blocker is terminal. Today that signal
dies in the durable-run ledger: an operator has to hand-read `ledger.json` /
`pipeline loop audit` to discover that the loop hit a genuine engine defect. A
repeated or terminal blocker is exactly the kind of engine-defect signal the
`pipeline improve` clustering path already turns into tracked backlog issues for
papercuts (#421) and recurring corrections (#500) — the durable-run blocker is
the missing sibling source.

This change adds a `durable-run-blocker` cluster category so terminal or
recurring durable-run blockers surface as proposed `pipeline:backlog` issues
through the same cluster → report → `--apply`/auto-file machinery, with the same
open-issue dedup, per-window rate cap, sanitization, provenance, and cross-host
reconciliation as the papercut category (#421) — reused unchanged. The
"does this join the current release?" decision stays human: the cluster report
*suggests* a milestone, it never assigns one.

## What Changes

- **`pipeline improve` gains a `durable-run-blocker` cluster category.** It reads
  typed blocker records — `blocked_theme` (a `DurableBlockerClass`),
  `evidence_fingerprint`, and any terminal `LoopStopRecord` — from the in-repo
  durable-run ledgers under the loop state home (`<state-home>/runs/<run-id>/`),
  a distinct source from the `.agent-pipeline/runs/` events the existing five
  categories read.
- **A new qualification rule distinct from the pure count gate.** A cluster
  qualifies to file when either a durable run stopped terminally on that blocker,
  **or** the same `(class, fingerprint)` recurs across ≥ 2 distinct runs. A
  single non-terminal occurrence never files.
- **The dry-run report suggests a milestone.** Each `durable-run-blocker` cluster
  lists its fingerprint, affected runs, theme (blocker class), and a *suggested*
  milestone. `--apply` and the enabled auto-file path file via the existing #421
  machinery with its dedup and rate caps unchanged; the filed issue carries only
  `pipeline:backlog` and **never** a milestone.
- **Filed issues carry ledger reproduction context** — run ids, item ids, the
  blocker class, the evidence fingerprint, and the blocker evidence excerpt —
  passed through the store's existing sanitization (secret redaction + injection
  screening) before creation, with an auto-file provenance marker distinct from
  the papercut and correction markers.
- **Opt-in and inert by default**, gated on a resolved `durable_runs.auto_file`
  config setting, mirroring the papercut/correction blocks; best-effort and total
  so it can never fail a durable run, cycle, stage, or batch.

## Acceptance Criteria

- [ ] `pipeline improve` reports a `durable-run-blocker` cluster category derived
      from typed blocker records (`blocked_theme`, `evidence_fingerprint`, and
      terminal `LoopStopRecord`) read from in-repo durable-run ledgers under the
      loop state home.
- [ ] A durable run that stopped terminally on a blocker forms a qualifying
      cluster from a single run.
- [ ] The same `(blocker class, evidence fingerprint)` recurring across ≥ 2
      distinct runs forms a qualifying cluster.
- [ ] A single non-terminal blocker occurrence forms no qualifying cluster and is
      never auto-filed.
- [ ] The dry-run report lists, per cluster: the evidence fingerprint, the runs
      affected, the theme (blocker class), and a suggested milestone; no milestone
      is ever assigned to a filed issue.
- [ ] `--apply` and the enabled auto-file path file one `pipeline:backlog` issue
      per qualifying, not-already-tracked cluster through the existing #421 path,
      with its open-issue dedup and per-window rate cap unchanged.
- [ ] A qualifying cluster whose proposed `[pipeline-improve]` title already
      matches an open issue is not re-filed.
- [ ] A filed issue body carries the run ids, item ids, blocker class, evidence
      fingerprint, and evidence excerpt from the ledger, passed through the
      store's existing sanitization, and declares agent/pipeline-reported
      provenance.
- [ ] The feature is inert by default: with `durable_runs.auto_file` absent or
      `false`, no issue is created and no `gh` call is made on its behalf, and a
      durable run's events, ledger, output, and exit status are byte-identical to
      the pre-feature behaviour.
- [ ] Regression tests via the deps seam prove: a terminal-stop cluster files; a
      repeated-fingerprint cluster files; a single non-terminal occurrence does
      not; and a duplicate of an open issue is not re-filed.

## Impact

- Affected specs: `improve-command` (adds the sixth-plus `durable-run-blocker`
  category), new capability `durable-run-blocker-auto-file`.
- Affected code (implementation step, not this proposal): the improve clustering
  layer (`core/scripts/improve.ts`), the auto-file category machinery
  (`core/scripts/stages/papercut.ts`), the durable-loop store read seam
  (`core/scripts/loop/store.ts`), the durable-run terminal-stop trigger
  (`core/scripts/loop/supervisor.ts`), config (`core/scripts/config.ts`), and the
  generated `plugin/` mirror.

## Out of Scope

- Changes to blocker classification or typing itself (owned by #509).
- Changes to the upstream fault-reporting path (#502) — this covers only the
  local/in-repo sibling; the two share only the detection layer.
- New dedup or rate-cap mechanisms — this reuses the #421 papercut machinery
  as-is.
- Auto-closing a filed blocker issue when the blocker stops recurring.
- Any automatic milestone assignment — the report only suggests.
