## Context

The pipeline today has no pre-run validity check. Failures due to missing CLIs, expired GitHub auth, stale `node_modules`, or a missing `openspec` binary surface inside the agent loop — sometimes after the planner has already emitted a plan and consumed tokens. The SmallHarness `doctor`/capability-check pattern shows the value of a fast, no-model preamble that gives a deterministic "runnable" signal; this change ports the useful slice of that pattern to agent-pipeline's coordinator role.

## Goals / Non-Goals

**Goals**
- Deterministic, model-free preflight that surfaces the most common setup defects before any autonomous work begins.
- Standalone `pipeline doctor` command for use in CI or onboarding.
- Opt-in run-start integration (`doctor.runOnStart: true` or `--doctor` flag) that blocks the run on failure.
- Actionable remediation text per failing check (what to run, not just what failed).
- Injectable deps seam so all checks are unit-testable without real filesystem, network, or subprocess calls.

**Non-Goals**
- Auto-remediation (installing packages, refreshing tokens). Doctor reports; the human fixes.
- Model-quality benchmarking.
- Replacing the existing test gate — doctor is complementary, not a substitute.
- Exhaustive environment auditing (OS version, disk space, etc.) — scope is the pipeline's declared dependencies only.

## Decisions

**Decision: collect-all failures, not fail-fast.** Running every check and presenting all failures at once is more useful for onboarding and CI than stopping at the first. The `failFast` config key defaults `false`; setting it `true` gives the stop-at-first behaviour for environments where speed matters.

**Decision: standalone command + opt-in run-start, not always-on.** Existing runs must be unaffected by default (acceptance criterion). Opt-in via `doctor.runOnStart: true` or `--doctor` keeps the path explicit; it also avoids adding latency for frequent automated runs where the environment is already known-good.

**Decision: injectable deps (`DoctorDeps`) following the `AdvanceReviewDeps` / `ShaGateDeps` precedent.** Each check becomes a function over `DoctorDeps` — an object of thin I/O primitives (`execCheck`, `fsExists`, `readFile`, etc.) — so tests can inject fakes without touching the filesystem, network, or subprocess layer. This matches the established pattern in `stages/` and keeps the check logic unit-testable.

**Decision: checks declared as a typed array, not ad-hoc conditionals.** Each check is a `PreflightCheck` record `{ id, description, run: (deps) => CheckResult }`. The runner iterates them, collecting results. This makes it easy to add/remove checks, and the `--status` surface can report per-check results consistently.

**Decision: `--status` reads the latest stored result from a result file rather than re-running checks.** Re-running on every `--status` would be slow and surprising; a stored result with a timestamp lets the user see the last known state quickly. The file lives at `/tmp/pipeline-{domain}-doctor-result.json`, keyed by domain — mirroring the existing `/tmp/pipeline-{domain}*` lock and kill-switch convention — **not** inside the repo (e.g. under `.claude/`). Storing it in the repo would create an untracked file that the doctor's own worktree-cleanliness check would then flag, and would risk being committed accidentally; `/tmp` avoids both.

**Decision: lock-file freshness via mtime comparison.** `npm ci` guarantees `node_modules` is in sync; the cheapest proxy without running `npm install --dry-run` is comparing the `package-lock.json` mtime to the `node_modules` mtime. This is a heuristic, not a guarantee — the remediation text says "run `npm ci`", which is the correct fix regardless.

## Risks / Trade-offs

- *mtime heuristic gives false positives on fresh clones* → remediation text is harmless (`npm ci` is idempotent); false positives in doctor are preferred over silent failures.
- *`gh auth status` is slow (~300ms) on cold runs* → acceptable for an explicit `doctor` call; on run-start the total preflight budget is bounded by the number of checks (all fast except gh).
- *Stored `--status` result goes stale* → include a timestamp in the output so the user knows how old it is; re-run `doctor` to refresh.
- *New `DoctorDeps` seam increases test surface* → the pattern is already established across three other stage modules; the incremental surface is low.

## Open Questions

- Should `runOnStart` default `true` in a future major version? Deferred — keep `false` now to not break existing users, revisit post-v1.2 with telemetry.
