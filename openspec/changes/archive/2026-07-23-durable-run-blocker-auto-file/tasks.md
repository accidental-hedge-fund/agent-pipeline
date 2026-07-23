# Tasks — durable-run-blocker auto-file

## 1. Durable-ledger evidence read seam

- [x] 1.1 Add a read-only projection over the durable-loop store
      (`core/scripts/loop/store.ts` seam) that enumerates in-window durable-run
      ledgers under the loop state home and yields, per run: run id, terminal
      `LoopStopRecord` (if any), and each item's `blocked_theme`,
      `evidence_fingerprint`, `item_id`, and blocker evidence excerpt.
- [x] 1.2 Make the projection injectable (deps seam) and read-only — no lock, no
      ledger write, no event append; a single unreadable/partial ledger is
      skipped, never fatal.

## 2. `durable-run-blocker` cluster category

- [x] 2.1 Add `durable-run-blocker` to the `ClusterCategory` union and a
      `clusterDurableRunBlockers` accumulator in `core/scripts/improve.ts`, keyed
      on `durable-run-blocker:<class>:<fingerprint>`.
- [x] 2.2 Record per cluster: category, signal (the theme / blocker class),
      occurrence count, distinct affected run ids, evidence excerpt (≤ 200 chars),
      the evidence fingerprint, whether any occurrence was a terminal stop, and
      the affected item ids.
- [x] 2.3 Derive a deterministic *suggested* milestone from the blocker class
      (advisory only) and surface it in the cluster entry.
- [x] 2.4 Extend `proposedTitle` so a `durable-run-blocker` cluster's title
      identity is `(class, fingerprint)`, never free-text prose.

## 3. Qualification predicate

- [x] 3.1 Qualify a cluster when a terminal stop is attributable to it **or** it
      recurs across ≥ 2 distinct runs (recurrence honoring the `min_occurrences`
      floor of 2). A single non-terminal occurrence never qualifies.
- [x] 3.2 Ensure the shared dedup/rate-cap in `autoFileClusterCategory` runs over
      the already-qualified set unchanged.

## 4. Report + auto-file wiring

- [x] 4.1 Render `durable-run-blocker` clusters in the dry-run report and JSON
      output: fingerprint, runs affected, theme, and suggested milestone.
- [x] 4.2 Add a `DURABLE_RUN_BLOCKER_AUTO_FILE_CATEGORY` (`AutoFileCategory`) with
      a distinct provenance marker
      (`<!-- pipeline:durable-run-blocker-auto-filed -->`) and a `buildBody` that
      emits sanitized ledger reproduction context (run ids, item ids, class,
      fingerprint, evidence excerpt) + the suggested-milestone note, declaring
      agent/pipeline-reported provenance. The filed issue carries only
      `pipeline:backlog` — no milestone.
- [x] 4.3 Add an `autoFileDurableRunBlockers` entry point reusing
      `autoFileClusterCategory` (dedup, rate cap, sanitization, cross-host
      reconciliation unchanged).

## 5. Config + trigger

- [x] 5.1 Add a `durable_runs` config block (`auto_file`,
      `auto_file_window_hours`, `auto_file_max_per_window`,
      `auto_file_min_occurrences` with a floor of 2), inert by default, mirroring
      the papercut/correction blocks in `core/scripts/config.ts` and the sample
      `pipeline.yml` emitter.
- [x] 5.2 Trigger `autoFileDurableRunBlockers` at durable-run terminal stop /
      completion (`core/scripts/loop/supervisor.ts` drive end), gated on
      `durable_runs.auto_file`, best-effort and total (caught, logged non-fatal,
      swallowed — never alters run/cycle/stage/batch outcome).

## 6. Tests (deps seam, no real I/O)

- [x] 6.1 Terminal-stop cluster files (single run with a terminal
      `LoopStopRecord`).
- [x] 6.2 Repeated `(class, fingerprint)` across ≥ 2 runs files.
- [x] 6.3 Single non-terminal occurrence does not file and is not reported as
      qualifying.
- [x] 6.4 A qualifying cluster whose title matches an open issue is not re-filed
      (dedup).
- [x] 6.5 Rate cap and sanitization (a secret in evidence is redacted in the
      filed body) hold for this source.
- [x] 6.6 Inert-by-default: with `durable_runs.auto_file` absent/`false`, no
      issue is created and no `gh` call is made; run artifacts are unchanged.
- [x] 6.7 Report lists fingerprint, runs, theme, and suggested milestone; the
      filed issue carries no milestone. Prove each test bites (fails without the
      change).

## 7. Mirror + gate

- [x] 7.1 Regenerate the `plugin/` mirror (`node scripts/build.mjs`) and commit it
      in the same change.
- [x] 7.2 `npm run ci` green (core tests, mirror check, install smoke,
      `openspec validate --all`).
