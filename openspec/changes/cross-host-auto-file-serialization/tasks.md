# Tasks — cross-host auto-file serialization

## 1. Auto-file cross-host safety (`core/scripts/stages/papercut.ts`)
- [x] 1.1 Extend `AutoFileDeps` with a `closeIssue(number: number, comment: string) => Promise<void>`
      seam (and any list-refresh seam needed) and wire the real impl to `gh issue close`/comment.
- [x] 1.2 Recompute the in-window auto-filed count from GitHub-authored issue state
      at/immediately-before each create, replacing the single up-front snapshot decrement, so a
      concurrent host's already-created issue counts toward the cap before this host files.
- [x] 1.3 After each successful create, re-list improve issues; when the just-filed title maps to
      more than one open issue, keep the lowest-numbered open issue and close the rest with an
      explanatory comment referencing the survivor.
- [x] 1.4 Keep every new step inside the existing best-effort outer `try/catch`: a failing
      list/close logs a non-fatal warning and never fails the run, stage, or batch.
- [x] 1.5 Preserve single-host behavior exactly: when only one host runs, no extra close calls and
      no reconciliation occur, and output/artifacts match pre-change behavior.

## 2. Tests (`core/scripts/stages/papercut.test.ts`)
- [x] 2.1 Cross-host duplicate: two invocations against a shared fake GitHub each create the same
      title; assert reconciliation leaves exactly one open issue and closes the rest.
- [x] 2.2 Cross-host cap: concurrent invocations against a fake GitHub near the cap converge to
      ≤ `auto_file_max_per_window` open auto-filed issues in-window.
- [x] 2.3 Single-host regression: one host, no duplicates → zero `closeIssue` calls, identical
      output (prove the test bites — it should fail if reconciliation fires spuriously).
- [x] 2.4 Best-effort: a throwing `closeIssue`/list is caught, logged non-fatal, and the run still
      completes with unchanged exit status.
- [x] 2.5 All tests inject I/O via `AutoFileDeps` — no real network, git, or gh.

## 3. Concurrency-scope declaration + assessment
- [x] 3.1 Add a single-host supported-scope statement to project docs (`CLAUDE.md` / README /
      `openspec/project.md`) covering the host-local `/tmp` lock sites.
- [x] 3.2 Record the cross-host assessment of the advance lock, queue batch serialization, and
      live-planning marker (the design.md table) as the durable rationale.

## 4. Mirror, gate, commit
- [x] 4.1 `node scripts/build.mjs` and commit the regenerated `plugin/` mirror in the same change.
- [x] 4.2 `openspec validate cross-host-auto-file-serialization` passes.
- [x] 4.3 `npm run ci` passes from repo root (core tests, mirror check, install smoke, openspec validate).
