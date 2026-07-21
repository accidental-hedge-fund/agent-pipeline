## 1. Groundwork

- [ ] 1.1 Verify the real `gh issue list --json` field shapes used by dedup and the rate cap
      (`title`, `state`, `createdAt`, `number`, `url`, `labels`) against actual `gh` output before
      coding against them (golden rule 5); record the confirmed shape in a code comment.
- [ ] 1.2 Re-read `core/scripts/improve.ts` clustering seams (`ClusterAccum`, `clustersToEntries`,
      `applyIssues`) and `core/scripts/stages/papercut.ts` to confirm the reuse surface.

## 2. `improve`: the `papercut` cluster category

- [ ] 2.1 Extend `ClusterCategory` with `"papercut"`.
- [ ] 2.2 Add `clusterPapercuts(event, runId, clusters)` following the `clusterBlockers` shape: match
      `type === "papercut"`, key on `papercut:${normalizeSignal(message)}`, excerpt from the message.
- [ ] 2.3 Call it from the event loop in `runImprove` alongside the existing clusterers.
- [ ] 2.4 Tests: repeated messages cluster; distinct messages stay separate; runs with no papercut
      events produce no papercut cluster; papercut clusters appear in `formatReport` and `formatJson`.

## 3. `improve`: category isolation guarantee

- [ ] 3.1 Add a runtime test asserting a `papercut` signal and an identically-normalized `blocker`
      signal produce two clusters with independent counts (types are stripped, not checked — the
      invariant needs a real test).
- [ ] 3.2 Add a test asserting a papercut cluster and a flaky-gate/token-waste cluster about the same
      stage remain separate entries in the report.

## 4. `improve --apply`: open-issue dedup

- [ ] 4.1 Add `listOpenImproveIssues: () => Promise<Array<{ title: string; url: string }>>` to
      `ImproveDeps`, implemented in `realImproveDeps` via one `gh issue list` call filtered to open
      issues with the `[pipeline-improve]` title prefix.
- [ ] 4.2 In `applyIssues`, fetch the list once, skip clusters whose proposed title already matches
      an open issue, and annotate the skipped `ClusterEntry` with the existing issue URL.
- [ ] 4.3 Surface skipped-as-already-tracked clusters in `formatReport` and `formatJson`.
- [ ] 4.4 Tests (with a fake dep, no network): second apply files nothing; closed issue does not
      suppress; lookup called exactly once regardless of cluster count; dedup applies to papercut and
      non-papercut categories alike.

## 5. Config: the auto-file keys

- [ ] 5.1 Extend the strict `papercuts` zod block in `core/scripts/config.ts` with `auto_file`
      (boolean), `auto_file_window_hours` (positive), `auto_file_max_per_window` (positive int), and
      `auto_file_min_occurrences` (int ≥ 2).
- [ ] 5.2 Add defaults to `DEFAULT_CONFIG` (`auto_file: false` plus conservative window/cap/threshold)
      and thread them through every `papercuts` merge site in `config.ts`.
- [ ] 5.3 Update the `pipeline.yml` scaffold comment to mention the auto-file keys.
- [ ] 5.4 Tests: absent block → `auto_file` false; unknown key still rejected; out-of-range
      `auto_file_max_per_window` / `auto_file_min_occurrences` rejected with the field named;
      defaults resolved when only `enabled` is set.

## 6. Auto-file engine

- [ ] 6.1 Add `autoFilePapercuts(opts, deps)` to `core/scripts/stages/papercut.ts` with an injectable
      deps interface (`listOpenImproveIssues`, `createIssue`, `ghAuthCheck`, `readLines`, `readdir`,
      `readFile`, `now`, `log`) — no real network/git/subprocess in unit tests.
- [ ] 6.2 Reuse the `improve` clusterer over papercut events inside the trailing
      `auto_file_window_hours` window; filter to clusters meeting `auto_file_min_occurrences`.
- [ ] 6.3 Apply the shared open-issue dedup from step 4.
- [ ] 6.4 Enforce the per-window rate cap by counting existing `[pipeline-improve]` +
      `pipeline:backlog` issues created inside the window; log deferred clusters when capped.
- [ ] 6.5 Build the issue body: agent-reported provenance banner, normalized signal, count, run IDs,
      excerpt — assembled text passed through `sanitize()` from `artifact-sanitize.ts`.
- [ ] 6.6 Create issues with `--label pipeline:backlog` and nothing else (no assignee, milestone, or
      stage label).
- [ ] 6.7 Make the whole function total: catch everything, log a non-fatal warning, resolve normally.
- [ ] 6.8 Tests: qualifying cluster filed; below-threshold not filed; out-of-window events excluded;
      dedup suppresses; cap defers the remainder; body is sanitized and carries the provenance
      statement; only `pipeline:backlog` is applied; a throwing `createIssue` and an unauthenticated
      `gh` both resolve without throwing.

## 7. Trigger points

- [ ] 7.1 Hook `autoFilePapercuts` into `core/scripts/pipeline-run.ts` after `finalizeRun`, gated on
      resolved `papercuts.auto_file`, wrapped so failure cannot alter run outcome.
- [ ] 7.2 Hook it into `core/scripts/stages/queue.ts` after `batch-summary.json` is written, with the
      same gating and the same failure isolation.
- [ ] 7.3 Tests: with auto-file off, run finalization and batch completion make zero issue-creating
      calls and their artifacts/exit status are unchanged; with it on, each trigger fires once; a
      failing auto-file still leaves `run_complete`/`summary.json`/`batch-summary.json` written.

## 8. Docs, mirror, gate

- [ ] 8.1 Document the `papercut` improve category and the `papercuts.auto_file*` keys in `README.md`
      and the `hosts/*/SKILL.md` variants.
- [ ] 8.2 Regenerate the mirror: `node scripts/build.mjs`, commit `plugin/` in the same change.
- [ ] 8.3 Run `npm run ci` from the repo root and confirm it is green (`ci:core`, mirror check,
      install smoke, `openspec validate --all`).
