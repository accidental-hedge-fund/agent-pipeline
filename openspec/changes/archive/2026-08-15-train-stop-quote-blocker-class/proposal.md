## Why

Tugboat / `pipeline train` STOPs with notify lines like `advance failed for #1010: pipeline single exited with code 1` even when the loop run’s `events.jsonl` already recorded a specific stop class (`dependency_deadlock`, `supervisor_no_progress`, `recovery_exhausted`) or item block class. Operators cannot diagnose a ship failure from the notify line; they must open the loop run by hand. This is the **STOP surface** bug (#1074), not the underlying park causes (#1061, #1068, #1054, #1071).

## What Changes

- When an advance wave (or legacy single-item advance used only by thin adapters/tests) ends non-zero or records a non-ok per-item outcome, **train** SHALL build the operator-visible STOP / item-error / `train_status.blocker` string from available structured loop evidence, in this priority order when present:
  1. last `loop_run_stopped.reason` (and issue context when known)
  2. last `loop_item_blocked.class` plus the blocked issue number
  3. last blocker comment first line and/or `blocker_kind`
  4. only then the raw process exit code
- Train / ship notify SHALL **not** present a bare `exited with code N` (or equivalent exit-only phrase) as the **only** human-visible reason when any of (1)–(3) are available on that advance attempt.
- When no loop events (or equivalent structured evidence) exist for the attempt, train SHALL still include the exit code (or engine error message) and SHALL **not** invent a stop class.
- Exit codes remain non-zero on failure (no success-masking). Tugboat / ship-notify keep reading train blocker sidecars and status as today (#997 / `tugboat-thin-ship`); they gain useful text because train produces it.
- Class-over-site (ship-path autonomy): enrichment lives on the shared train advance-outcome / STOP classification path used by production train (and any shared helper that path uses), not a Tugboat-only string rewrite that leaves bare train JSON useless.

## Acceptance Criteria

- [ ] Fixture: advance/single stops with loop evidence `loop_run_stopped.reason = supervisor_no_progress` for a known issue → train error / `train_status.blocker` (and thus Tugboat/train notify detail that copies that blocker) contains the string `supervisor_no_progress` and the issue number.
- [ ] Fixture: advance/single exits non-zero with **no** loop events / no blocked-class evidence → train error / blocker still includes the exit code (or engine failure message) and does **not** invent a stop class name.
- [ ] Fixture: last evidence is `loop_item_blocked.class` (e.g. `recovery_exhausted`) for issue N → human-visible train STOP/item error includes that class and `#N` (or issue N) without requiring the operator to open `events.jsonl`.
- [ ] When richer evidence exists, the human-visible reason is **not** only `pipeline single exited with code 1` / `pipeline advance exited with code 1` (or equivalent exit-only phrase).
- [ ] Non-zero exit behavior is preserved: failed advance still yields non-zero train exit / incomplete status with blocker; this change does not flip failure to success.
- [ ] Unit tests inject deps (fake loop events / advance outcomes); no real network, git, or subprocess. If `core/` changes, regenerate `plugin/`. `npm run ci` green.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `integrated-train-mode`: Require train STOP / per-item advance-error / `train_status.blocker` text to quote structured loop stop and block evidence (reason, class + issue, blocker_kind / comment first line) before falling back to raw exit code; forbid exit-only as the sole human-visible reason when evidence exists; forbid inventing classes when evidence is absent.
- `tugboat-thin-ship`: Clarify that failed-train notify/state detail SHALL preserve train-produced structured stop class / reason text when present in the train blocker sidecar or `train_status.blocker` (no collapse back to exit-only when that text is available). Does not change Tugboat’s role as a thin reader of train output.

## Impact

- **Primary (intent for implement):** production train advance-outcome classification — likely `classifyTrainAdvanceLabels` / `advanceWaveThroughLoop` (and any shared helper that builds train STOP / item `error` / `blocker` strings from loop run artifacts) in `core/scripts/pipeline.ts` and `core/scripts/stages/train.ts`; tests in `core/test/train.test.ts` and related CLI/train fixtures.
- **Downstream (no new composer brain):** Tugboat `failure_detail` / ship-notify already surface `train.json.blocker` and train capture text; richer train text flows through without a second diagnosis engine in Tugboat.
- **Out of scope:** fixing underlying parks (`dependency_deadlock`, no-progress, recovery exhaustion, dirty worktree, Codex overflow, scheduler no-ops — #1061, #1068, #1054, #1071); changing exit codes; auto-file of ship failures; merge-inside-advance; second recoverer inside train; N×`single` as production path.
- **Program:** v1.39.1. No `Depends on`. Executable.
- **Related surfaces already in law:** #997 / tugboat failure detail (read path); this issue is the **write** path that makes that detail useful.
