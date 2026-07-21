## Why

#419 gave agents a way to log minor friction mid-run (`pipeline papercut`), but the resulting
`papercut` events are a write-only channel today: they land in `.agent-pipeline/runs/*/events.jsonl`
and nothing reads them except `pipeline papercut report --json`. Recurring friction therefore keeps
recurring — it is captured, and then silently forgotten.

`pipeline improve` already exists to turn recurring run evidence into candidate work, but it only
clusters telemetry the engine *infers* (`review-finding`, `blocker`, `flaky-gate`, `token-waste`).
Papercuts are a categorically different signal: they are first-hand agent reports of what was
actually annoying, not an inference from timings or outcomes. Feeding them through the same
clustering + issue-creation path closes the loop, and an opt-in auto-file path removes the last
human dependency (someone remembering to run `improve --apply`).

**Conflict surfaced (issue text vs. code).** Issue #421 says `--apply` uses "the existing dedup
logic against open `[pipeline-improve]` issues". No such dedup exists: `applyIssues()` in
`core/scripts/improve.ts` calls `deps.createIssue` unconditionally for every qualifying cluster,
and `openspec/specs/improve-command/spec.md` contains no dedup requirement. Re-running
`improve --apply` today creates duplicate issues. This change therefore **introduces** that dedup
as a shared primitive and applies it to all three paths (existing categories, the new papercut
category, and auto-file), rather than pretending to reuse something that is not there.

## What Changes

- Add a fifth `improve` cluster category, `papercut`, sourced from `papercut` events in
  `events.jsonl` and keyed by the normalized `message`. It appears in the dry-run report, the
  `--json` output, and the `--apply` issue-creation path on the same terms as existing categories.
- Guarantee **category isolation**: clusters are keyed by `<category>:<normalized-signal>`, so a
  `papercut` cluster and a `flaky-gate`/`token-waste` cluster describing the same underlying
  problem are never merged into one cluster. Agent-reported and telemetry-inferred evidence stay
  distinguishable in the report and in any issue created from it.
- Introduce open-issue dedup for `improve --apply`: before creating an issue for a cluster, query
  open issues whose title starts with the `[pipeline-improve]` prefix and skip the cluster when its
  proposed title already has an open issue. GitHub is the dedup source of truth — no new local
  state file.
- Extend the strict `papercuts` config block with an opt-in auto-file group, all defaulting to off /
  conservative: `auto_file` (bool, default `false`), `auto_file_window_hours`,
  `auto_file_max_per_window`, and `auto_file_min_occurrences`. Unknown keys remain rejected.
- When `papercuts.auto_file` is `true`, the engine clusters in-window papercuts and files
  `pipeline:backlog` issues at two points: run finalization (`run_complete`) and the end of a
  `pipeline queue` batch. Auto-filing reuses the same clustering, threshold, and dedup code as
  `improve --apply`.
- Auto-filed issue bodies carry sanitized event detail and an explicit agent-reported provenance
  statement, and receive the `pipeline:backlog` label and nothing else — no assignee, no milestone,
  no queueing, no advancement toward `ready`.
- Auto-filing is best-effort: any failure is logged and swallowed, exactly like the `papercut`
  record path. It can never fail a stage, set a blocker, or change a run's exit status.

## Capabilities

### New Capabilities
- `papercut-auto-file`: the opt-in `papercuts.auto_file` path — its config keys, its two trigger
  points (`run_complete` and queue-batch end), the per-window rate cap, the minimum-occurrence
  threshold, the `pipeline:backlog`-only labelling, the agent-reported body contract, and its
  never-fail-the-run guarantee.

### Modified Capabilities
- `improve-command`: gains the `papercut` cluster category, the category-isolation guarantee, and
  open-issue dedup for `--apply`.
- `papercut-capture`: the strict `papercuts` config block gains the auto-file keys; absent block
  and `auto_file` unset both remain fully inert.

## Impact

- `core/scripts/improve.ts` — `ClusterCategory` union, `clusterPapercuts()`, dedup in
  `applyIssues()`, `listOpenImproveIssues` dep on `ImproveDeps`.
- `core/scripts/stages/papercut.ts` — auto-file entry point (clustering reuse + gh issue creation).
- `core/scripts/config.ts` — `papercuts` zod schema, defaults, merge sites, scaffold comment.
- `core/scripts/pipeline-run.ts` — best-effort auto-file hook after `finalizeRun`.
- `core/scripts/stages/queue.ts` — best-effort auto-file hook after `batch-summary.json`.
- `core/test/improve.test.ts`, `core/test/papercut.test.ts`, `core/test/config.test.ts` — unit tests.
- `plugin/` mirror — regenerated (`node scripts/build.mjs`).
- `README.md` / `hosts/*/SKILL.md` — document the new category and the auto-file config keys.

## Out of Scope

- Auto-queueing or auto-triaging papercut-derived issues past `pipeline:backlog`.
- Any change to the papercut capture channel itself (#419) — event shape, CLI, prompt injection.
- Scoreboard / metrics changes.
- Transcript mining or any new event source beyond existing `events.jsonl` papercut records.

## Acceptance Criteria

- [ ] `pipeline improve` (dry-run) over runs containing `papercut` events prints a report that
      includes a `papercut` cluster category alongside the existing categories, showing the
      normalized signal and occurrence count for each group.
- [ ] A `papercut` cluster and a `flaky-gate` or `token-waste` cluster describing the same
      underlying problem are reported as two separate clusters under their own categories, never
      merged into one.
- [ ] `pipeline improve --apply` creates one GitHub issue per `papercut` cluster whose occurrence
      count meets `--min-occurrences`.
- [ ] Re-running `pipeline improve --apply` when an open `[pipeline-improve]` issue already exists
      for a cluster creates no second issue for that cluster — for papercut and non-papercut
      categories alike.
- [ ] A single-occurrence (singleton) papercut cluster appears in the dry-run report and `--json`
      output but is never issue-created by `--apply`.
- [ ] With no `papercuts` block, or with `papercuts.auto_file` absent or `false`, a run reaching
      `run_complete` and a completed `pipeline queue` batch create zero issues and produce output,
      artifacts, and exit status byte-identical to the pre-change behaviour.
- [ ] With `papercuts.auto_file: true`, a run reaching `run_complete` and the end of a queue batch
      each create issues for in-window papercut clusters meeting `auto_file_min_occurrences`.
- [ ] Every auto-filed issue carries the `pipeline:backlog` label.
- [ ] Every auto-filed issue body contains sanitized papercut detail text (secret-redacted,
      injection-screened) and an explicit statement that the content is agent-reported, not
      human-authored.
- [ ] No issue is auto-filed for a cluster that already has an open `[pipeline-improve]` issue.
- [ ] Once `auto_file_max_per_window` issues have been filed within `auto_file_window_hours`, further
      qualifying clusters in that window are logged/reported but not filed; filing resumes in the
      next window.
- [ ] Auto-filed issues carry no label other than `pipeline:backlog`, no assignee, and no pipeline
      stage label — they are not queued and not advanced toward `ready`.
- [ ] An auto-file failure (gh unauthenticated, network error, throwing issue creation) is logged as
      a non-fatal warning; the run/batch still completes with its pre-change exit status and no
      `blocker_set` event is emitted as a result.
