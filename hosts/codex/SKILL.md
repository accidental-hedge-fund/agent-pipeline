---
name: pipeline
description: |
  Use this skill whenever the user wants to advance a GitHub issue or PR
  through a label-driven dev pipeline toward `pipeline:ready-to-deploy`.
  Triggers include phrases like "pipeline issue 419", "push #360 forward",
  "advance this PR through review", "run the pipeline on an issue", `$pipeline`,
  or the legacy `/pipeline` command. Do NOT use this skill for: general PR review,
  backlog triage/cleanup (use $sweep), or deploying a finished item.
---

# Pipeline

This skill keeps the old `/pipeline` workflow as Codex skill `$pipeline`.
Treat the text after `$pipeline`, `/pipeline`, or the natural-language request as the argument string.

Self-contained TypeScript skill that advances a GitHub issue (or PR's linked
issue) through a 13-stage label-driven state machine, ending at
`pipeline:ready-to-deploy`. The pipeline does NOT auto-merge — the user owns
the merge button.

## Developing this skill itself (core/ → plugin/ mirror)

When the work target is the agent-pipeline repo — any implementation, fix, or
test-fix step that edits a file under `core/` — `plugin/` is a generated mirror
of `core/` (+ `hosts/claude`). After editing any file under `core/`, run
`node scripts/build.mjs` from the repo root and include the regenerated
`plugin/` in the same commit. A core-only commit fails CI's
`build.mjs --check` gate and burns a fix-loop attempt on the stale mirror.

## State machine

```
backlog → ready → planning → implementing
              → review-1 → fix-1 → review-2 → fix-2
              → pre-merge → eval-gate → shipcheck-gate → ready-to-deploy
```

Each item carries one `pipeline:<stage>` label and at most one `blocked`
label. Stage transitions are driven by structured outcomes from the stage
handlers in `scripts/stages/`. The skill **owns** the labels — it sets,
removes, and transitions them as side-effects of running the underlying
stage logic. There is no separate orchestrator process.

`backlog` is a triage marker (e.g. set by `$sweep`). `$pipeline` starts work
at `ready` and only acts on items that already carry a `pipeline:*` label.

## Modes

The primary invocation is the advance loop; all other operations are available as
distinct `$pipeline:<command>` entries in the skill menu.

```
$pipeline N                              advance loop (default; up to 12 transitions)
$pipeline N --once                       advance one stage and stop
$pipeline N --dry-run                    log what would happen; no harness calls, no GitHub writes
$pipeline N --domain d                   override domain name in lock/log paths
$pipeline N --base branch                override base branch
$pipeline N --repo-path path             target a different repo working tree
$pipeline N --detach                     run the advance loop in a detached background process

$pipeline:status <N>                     read-only; print stage, blocker, PR, last review
$pipeline:unblock <N> "answer"           post answer and clear blocked label
$pipeline:override <N> "key: reason"     disposition a review finding and auto-resume the advance loop
$pipeline:summary <N>                    print the evidence bundle for issue N (local, offline)
$pipeline:doctor                         deterministic preflight check; print summary, exit 0/1
$pipeline N --doctor                     run the preflight before advancing; abort the run on any failure
$pipeline:init                           ensure labels + scaffold .github/pipeline.yml
$pipeline:cleanup                        sweep merged-PR worktrees
$pipeline:intake [--description "text"]  spec a rough description into a GitHub issue + ROADMAP PR
$pipeline:triage <N> --stage ready       set pipeline:ready on issue N
$pipeline:triage <N> --stage backlog     set pipeline:backlog on issue N
$pipeline:sweep                          batch re-spec thin issues + reconcile ROADMAP.md (dry-run)
$pipeline:sweep --apply                  same, with write-backs applied
$pipeline:roadmap                        dependency-aware scored roadmap for the backlog (dry-run)
$pipeline:roadmap --apply                same, with write-backs applied
$pipeline:merge <pr>                     human-only squash merge of a ready-to-deploy PR (never called by the advance loop)
$pipeline:merge-queue --milestone <m>    dry-run ordered R2D merges for a milestone (no merges)
$pipeline:merge-queue --milestone <m> --apply  sequential merges via existing merge surface
$pipeline:merge-queue --milestone <m> --apply --release-when-complete --release-version minor
                                         after a complete queue, prepare a release PR (never tags/merges/publishes)
$pipeline:release <version>              prepare a release PR for the given version
$pipeline:logs [<run-id>] [-f]           list or stream pipeline run logs
$pipeline:loop --milestone v2            canonical durable multi-item run — driven entirely in-repo by this skill's own supervisor
$pipeline:loop --resume <run-id>         resume an existing durable run by id, on either engine
$pipeline:loop --audit                   read-only report for the run; no writes
$pipeline loop logs [<run-id>] [--events] [-f]  dump or follow a durable loop run's events.jsonl (default: exit 0 on loop_run_stopped; --no-until-terminal for interrupt-only)
$pipeline:loop --audit                   read-only report (process identity, action evidence, per-item stage table); no writes
$pipeline:loop --resume <run-id> --audit --follow  stream whole-run stage-progress lines (not harness stdout)
$pipeline loop logs [<run-id>] [--events] [-f]  dump or follow a durable loop run\'s events.jsonl (default: exit 0 on loop_run_stopped; --no-until-terminal for interrupt-only)
$pipeline summary <run-id>               print evidence bundle for an exact run (domain-independent)
$pipeline scoreboard                     print read-only factory throughput/cost/reliability metrics from run artifacts
$pipeline scoreboard --bucket day|week   add a chronological day/week time-series to the scoreboard report
$pipeline scoreboard --by <dimension>    group scoreboard metrics by harness|model|effort|executor (exactly one; missing/absent identities report as `unknown`, dimensions that can't apply — e.g. executor on a local-harness stage — report as `not applicable`)
$pipeline scoreboard --corrections-by <dimension>  group repeat-correction/recurrence metrics by repo|stage|harness|model|source_kind|failure_class|proposed_control|implemented_control (exactly one)
$pipeline scoreboard --html <path>       write a self-contained, offline HTML export of the report to <path> (local/archival only; makes no network requests, composes with the other scoreboard flags)
$pipeline evals plan experiment.json     expand + persist an experiment's run plan; invokes no harness, creates no worktree
$pipeline evals run experiment.json      execute an experiment's cells (resumable); never writes to production GitHub
$pipeline evals grade experiment.json/exp1   grade a completed experiment's cells; writes grades.jsonl (never gates a PR)
$pipeline evals run experiment.json --trajectory-max-events <n> --trajectory-max-bytes <n>  override the default trajectory/verifier artifact bounding ceilings (default: 200 events / 200000 bytes)
$pipeline evals report experiment.json/exp1 --baseline <treatment_id>  paired comparative summary.json
$pipeline evals report experiment.json/exp1 --baseline <treatment_id> --link-artifacts  additionally link trajectory/verifier artifacts for flagged cells (opt-in; default output unchanged)
$pipeline evals harvest request.json     draft an eval fixture from sanitized run/correction evidence; --apply [--plan-only] to promote (never writes GitHub)
$pipeline --version                      print the package version, then exit (no number; -V alias)
```

**Deprecated flag forms** (still work, emit a one-line deprecation notice to stderr):
```
$pipeline N --status        → use $pipeline:status N
$pipeline N --summary       → use $pipeline:summary N
$pipeline N --unblock "…"   → use $pipeline:unblock N "…"
$pipeline N --override "…"  → use $pipeline:override N "…"
$pipeline --init            → use $pipeline:init
$pipeline --cleanup         → use $pipeline:cleanup
```

The number is auto-detected as an issue or PR via the GitHub API. PRs are
resolved to their linked closing issue (the pipeline is issue-centric). PRs
without a `Closes #N` reference are refused with an explanation.

`$pipeline:loop` is the canonical command for a **durable** multi-item run —
one that is expected to span sessions or engines. It runs a deterministic,
read-only preflight in this skill (argument normalization,
`loop:store-schema-compatibility`, native-`/goal` capability), then drives the
run — contract, ledger, lock, recovery, reconciliation, resume — entirely
in-repo through this skill's own durable loop supervisor. It never discovers,
requires, or invokes an externally installed goal-loop skill, and it never
sets a stage label or merges itself; every selected item still executes
through this skill's own state machine and evidence gates via the
`pipeline/loop-execution@1` hand-off contract. It refuses to start (with zero
durable writes) when Codex's built-in autonomous `/goal` mode is unavailable —
there is no non-durable fallback loop. Multi-item drive is **long-running**
(foreground for the whole wall-clock of the run): on successful create/resume
and exclusive lock, before the first item dispatch, the CLI emits an early
machine-readable stdout JSON line (`kind: "loop_run_handoff"`) with `run_id`
and the absolute `events` path so a harness can follow structured progress; a
terminal summary JSON is printed when the supervisor finishes. `--resume
<run-id>` takes over a run whose prior supervisor is provably gone; a run
whose supervisor is still alive is refused rather than double-driven.
`--audit` renders the run's process identity, action-evidence timeline,
watchdog/no-progress state, and a **per-item stage-progress table** (stage +
optional round + advance run-id drill-down) with zero durable writes (no drive
handoff). Combine with `--follow` (`--resume <run-id> --audit --follow`) to
stream clean one-line stage transitions for the whole run — not interleaved
harness stdout. A pre-existing run created by a legacy goal-loop invocation
remains addressable by `--resume <run-id>` (read-only import).

The native-`/goal` check never treats an absent marker in `codex --help` as
evidence the capability is missing (a native goal mode is a slash command, not
a CLI flag). It resolves an operator attestation
(`loop.native_goal_attestation: available | unavailable` in
`.github/pipeline.yml`, overriding everything else) first, then a positive
`--help` marker, then a documented version floor against `codex --version` —
codex currently has no documented floor (no known native goal mode), so it
fails closed on detection alone and needs an `available` attestation to run
(#506).

#### Bootstrapping a durable run: native `/goal` then `$pipeline:loop`

Starting a durable run is an **operator-owned, two-step bootstrap** performed
inside a Codex session:

1. Run `/goal` to enter Codex's built-in autonomous mode.
2. Inside that `/goal` session, invoke `$pipeline:loop …` to start the durable
   run.

This skill does **not** detect whether `/goal` is active — the native-`/goal`
check above only probes the *capability* (attestation, `--help` marker,
version floor — and, as noted, Codex has no documented floor so it needs the
`available` attestation), not live session state. This skill does **not**
invoke or re-enter `/goal` itself; entering `/goal` is the operator's action,
taken before `$pipeline:loop` is ever run. And this skill does **not** control
the native `/goal` session's lifecycle: `/goal` is the outer autonomous
driver, `$pipeline:loop` is the durable workload it runs inside that driver.

Native completion is likewise a **host/user action**. `$pipeline:loop` reports
its own terminal done and reconciliation conditions from the durable loop
engine (see `--audit` above); ending the native `/goal` session afterward is
something the operator or Codex's `/goal` mode does, not something this skill
performs. Consistent with the pipeline never merging, this skill neither ends
the `/goal` session nor merges once a run reports done.

`--cleanup` is the one mode that takes no number. It sweeps pipeline-managed
worktrees under `worktree_root` whose PR is already merged, removing the worktree
and deleting its local branch (the remote branch is never touched). It only
considers `pipeline/<N>-<slug>` worktrees, and skips — reporting the reason — any
that have uncommitted changes or a local HEAD that differs from the merged PR's
commit. It is idempotent and prints a removed/skipped summary before exiting.

`--init` also takes no number. It onboards a fresh repo in one step: ensures all
pipeline labels via `ensurePipelineLabels`, scaffolds a commented
`.github/pipeline.yml` with every key at its default (skipping the write, with a
notice, if the file already exists), and ensures a sentinel-delimited
engine-managed block in `.gitignore` covering every local-only artifact
directory the engine writes — `.agent-pipeline/runs/`, `.agent-pipeline/roadmap/`,
`.agent-pipeline/history/`, and `.agent-pipeline/evals/`. The `.gitignore` step creates the file if absent,
appends the block if missing (preserving every pre-existing byte), or refreshes
only the block's contents when it is present and stale. It is idempotent and
additive — a normal `$pipeline N` run still self-creates any missing labels, so
`init` is a convenience, not a precondition.

`config sync` also takes no number. It refreshes an existing
`.github/pipeline.yml` against the current init scaffold while preserving
effective configured behavior. Preview is the default and prints a diff without
writing; `--apply` writes only after the existing file and rendered candidate
both validate.

`config repo-map <add|remove|list>` also takes no number. `add`/`remove` mutate
only the `repo_map` block of `.github/pipeline.yml` (all other keys, comments,
and formatting are preserved), creating the block when absent; `add` is
idempotent and `remove` tolerates an absent entry (exit 0, warning). `--rel`
selects `depends_on` (default) or `depended_on_by`. `list` prints current
entries grouped by relationship kind.

`doctor` takes no number either. It runs a **deterministic, model-free** preflight
that checks required CLIs (`gh`, `node`), GitHub auth + repo access, worktree
cleanliness on protected branches, configured harness availability, npm install
freshness, whether the installed engine version is behind the latest
agent-pipeline release, and — when configured — the `openspec` CLI and the eval
command's binary. It prints a per-check pass/fail/warn summary with one-line
remediation on each failure or warning and exits `0` (all pass or warn) / `1`
(any fail). A stale install (`install:version-freshness`) only **warns** — it
never fails the preflight; run `npx github:accidental-hedge-fund/agent-pipeline
update` to refresh it. `update` refuses (non-zero exit, no file copied) while a
`/tmp/pipeline-*.lock` is held by a live pipeline run — updating underneath an
in-flight run used to swap the code/templates it reads out from under it
mid-run (#450). The refusal names every blocking lock path and PID; retry once
those runs finish, or pass `--force` to override (prints the same details as a
warning and proceeds). A run in progress is unaffected either way — it already
pinned its own template snapshot and engine identity at start, and reports any
detected drift as an `engine_drift` event without changing its outcome. Opt in
to run the preflight at the start of a real run
with `doctor.runOnStart: true` or `--doctor`: a failing check aborts **before
planning**, so no tokens are spent, while a warning prints but does not abort.
`--fail-fast` (or `doctor.failFast: true`) stops at the first failure. The
latest result is stored under `/tmp` and surfaced by `--status`.

`evals` is a manifest-driven **experiment runner**, not a gate: it replays
identical frozen fixtures through a matrix of harness/provider/model/effort
treatments so an observed difference is attributable to the treatment, not to
a changed issue, base commit, prompt version, or repository state. It is
unrelated to the `eval-gate` stage (a pass/fail check on a real PR) — `evals`
never touches `stages/eval.ts` and never participates in the label-driven
state machine.

An **experiment manifest** (JSON) declares `schema_version`, `experiment_id`,
`fixture_ids`, `mode` (one of `planning`, `plan-review`, `implementing`,
`review`, `fix`, `shipcheck`, or `end-to-end`), `treatments` (`harness` /
`provider` / `model` / `effort` axes, each a string array), `replicates`,
`seed`, `concurrency`, `timeout` (seconds, per cell), and `output_dir`
(default `.agent-pipeline/evals`). A **fixture** (JSON, one per frozen task)
declares `fixture_id`, `schema_version`, a full 40-char `base_commit`,
`task_input`, `stage_entry_artifacts` (frozen inputs keyed by the stages it
supports entering directly — see `core/evals/fixtures/` for one example per
stage), `public_checks`, `grader_refs`, `category`, `risk`, and `provenance`
(`synthetic` or `harvested`).

`evals plan <manifest>` expands the Cartesian fixture × treatment × replicate
matrix deterministically and writes `plan.json` **before** touching a harness
or creating a worktree — the same manifest and seed always produce the same
plan. `evals run <manifest>` additionally executes every cell that has no
completed record yet, in seed-derived order interleaved across harnesses,
each in a **fresh worktree checked out at the fixture's `base_commit`**
(never the current branch head) — no two cells, including replicates, share a
worktree, branch, or session. **Evaluation mode performs zero production
GitHub writes**: no label, comment, PR, or push — the gh surface used in this
mode refuses every mutating call. Interrupting and re-running `evals run`
never re-executes a completed cell or rewrites an existing
`runs.jsonl`/`failures.jsonl` line.

Results land under `<output_dir>/<experiment-id>/`: `manifest.json`,
`plan.json`, `runs.jsonl` (append-only, `completed` cells only), and
`failures.jsonl` (append-only, `infra_error` / `auth_error` / `timeout`
cells). Every record carries `experiment_id`, `fixture_id`, `treatment_id`,
`replicate`, `prompt_hash`, `config_hash`, `base_sha`, and `env_surface_hash`
(the fixture's environment-and-surface provenance hash, #535) so a cell can
be joined to ordinary run evidence.

### Objective grading and comparative reporting

`evals grade <experiment-dir>` / `evals report <experiment-dir> --baseline
<treatment_id>` turn a completed experiment into objective grades and an
uncertainty-aware comparison — like `evals` itself, **grades and summaries
never gate a PR and never participate in the label-driven state machine**.
`<experiment-dir>` is `<output_dir>/<experiment_id>`, the same directory
`evals run` wrote into.

Fixtures may additionally declare (all optional; omitting them still
validates): `hidden_checks` (resolved only by the grader, never exposed to
the treatment — rejected if also listed in `public_checks`),
`seeded_defects` (review ground truth: `defect_id`, `path` + line range,
`expected_severity`), `acceptance_criteria` (`id` + `statement`, plus
optional `check_names` for implementation/fix or `keywords` for planning
coverage), `allowed_change_paths` (the out-of-scope-change boundary — absent
means `null`, never `0`), and versioned `grader_refs`
(`{"grader": "review", "version": "1"}`; an unsupported grader/version fails
validation).

`evals grade` reads `manifest.json`/`runs.jsonl` and the fixtures and writes
`grades.jsonl` fresh each run — never modifying `manifest.json`, `plan.json`,
`runs.jsonl`, or `failures.jsonl`; regrading the same records is
byte-identical. Only `completed` cells whose fixture declares a matching
`grader_ref` are graded (others are reported `skipped`, never dropped
silently); `infra_error`/`auth_error`/`timeout` cells never get a substitute
score. Three deterministic, versioned graders: **`implementation-fix`**
(hidden-test pass rate, acceptance completion, a regression count measured
against a cached base-commit check baseline, a pre-existing-failure count,
and an out-of-scope-change count), **`review`** (deterministic path +
line-range matching against `seeded_defects` — precision/recall/F1, false
positives, and a signed severity-calibration distribution that never
cancels over/under calls; no model call), and **`planning`**
(`planning-rubric-v1`: requirement coverage, unsupported assumptions,
actionability, downstream compatibility — a treatment self-assessment is
recorded as a separate observation and never read as a grade input).

`--judge` (disabled by default) runs an optional model judge as its own
record, flags disagreements with the deterministic grade, and never moves a
deterministic field. A disagreement can carry a blinded human adjudication
record keyed by an opaque hash of `cell_id` — never harness/provider/model/
effort.

`evals report --baseline <treatment_id>` writes a versioned `summary.json`:
paired per-fixture quality deltas against the baseline (a fixture
contributes only when both treatments have a completed, graded cell for it;
replicates are reduced to one value before pairing; unpaired fixtures are
named, not dropped), completion/failure-class rates, quality-vs-duration and
quality-vs-cost Pareto frontiers (no combined score), and grouping by
stage/harness/provider/model/effort/category/risk with an explicit `unknown`
bucket. Every aggregate effect carries a confidence interval, its sample
size, and the seeded, reproducible interval method; small samples are marked
`underpowered` rather than hidden. A cell with no cost telemetry is excluded
from cost aggregates and counted toward a reported coverage fraction —
never zeroed.

`core/evals/fixtures/*.json` includes a small checked-in synthetic set
exercising every grader; the grading/reporting tests run entirely against
checked-in synthetic fixtures and recorded cell records — no live model
call, network request, real git operation, or subprocess spawn.

### Treatment trajectory and verifier evidence artifacts (#536)

Diagnostic evidence for one cell — **never** a gating input — lives in two
kinds of immutable, content-addressed artifacts, referenced by descriptor
(`{path, content_hash, schema_version, byte_count, truncation_status}`)
rather than embedded inline: a **treatment trajectory artifact** (`evals
run`, referenced as `trajectory_artifact` on `runs.jsonl`/`failures.jsonl`) —
bounded per-stage output/error/timing/success, produced-artifact paths, and
a capability-aware `tool_events` channel marked `unavailable` with a reason
for every harness/executor this engine currently drives; and a **verifier
evidence artifact** per deterministic grader and per optional judge (`evals
grade`, referenced as `verifier_artifact` on the grade/judge/disagreement
record) — inputs, checks/evidence consulted (hidden checks, seeded-defect
ground truth, and golden answers belong here, never in a treatment
trajectory), identity/version, and final result. Raw chain-of-thought is
neither requested nor required.

Both kinds are sanitized (secret-redaction/injection-denylist) and bounded
(deterministic head/tail retention, overridable via `--trajectory-max-events`/
`--trajectory-max-bytes`) before being content-addressed and written;
failures are logged, never fatal. Artifacts are immutable — resume/regrade
never rewrite one; identical content dedupes, a differing-content collision
at the same address is surfaced, never overwritten. `evals report
--link-artifacts` (opt-in; default output byte-identical) additionally
attaches these references for flagged cells (outliers, judge disagreements,
review false positives/negatives, failed cells) as `linked_artifacts`,
without changing any aggregate.

### Trace-to-fixture harvesting (`evals harvest`, #535)

`evals harvest <request.json>` turns sanitized evidence (a run-artifact
excerpt, a `pipeline improve` cluster, or a `correction_event`/control
proposal) into a **reviewable eval fixture draft**, draft-only by default —
`--apply` promotes; `--apply --plan-only` additionally proves the promoted
fixture expands into an executable cell plan. It is human-approved
authoring, not autonomous test-writing: it never queues, advances,
overrides, merges, or deploys, and makes no GitHub call at all. It resolves
a capability-surface inventory (stage, materialized prompts, harness/model
config, tools/hooks, repo paths, services/data), proposes exactly one
bounded ability/failure mode (never batching evidence spanning more than
one), and records why an eval is the right control level. Every evidence
excerpt is sanitized (secret redaction + injection denylist) before it can
reach a draft.

Fixtures may declare `environment` dependencies (`live | simulated |
forbidden` mode, versioned, with required permissions, initial state,
expected outputs/errors, and deterministic setup/teardown) — default is
`simulated`/`forbidden`; `live` requires an explicit maintainer selection
and is never proposed by default. The resolved `environment` + capability
surface are hashed into `env_surface_hash`, exposed off the fixture and
carried onto every derived cell record. A maintainer can iteratively revise
a draft before promoting; promotion always re-validates with the same
fixture loader (an invalid draft is rejected naming the offending field).

## Setup (zero install after first run)

The skill is a Node 24+ TypeScript codebase under
`~/.codex/skills/pipeline/core/scripts/`, run via native type-stripping (no
build step). First-ever invocation runs `npm install` automatically.

Required:
- `gh` CLI authenticated against the target repo
- `codex` CLI on PATH for planning, implementation, and fix
- `claude` CLI on PATH and authenticated — the reviewer harness (`prompt-harness` mode
  invokes it directly with a JSON-returning prompt, so **no review plugin is required**)
- Node 24+
- The skill never reads `ANTHROPIC_API_KEY`

Harness ownership is relative to the tool that invoked the pipeline. In the Codex skill, Codex is primary and Claude Code is secondary: Codex owns planning, implementation (documentation updates included, when `steps.docs` is on), and fixes; Claude Code owns review/adversarial review.

## Per-repo config

A repo can opt-in to overrides by committing `.github/pipeline.yml`:

```yaml
base_branch: main                # default 'main'
worktree_root: .worktrees        # relative to repo root
max_concurrent_worktrees: 5
auto_recovery_max_retries: 2
implementation_timeout: 1200     # seconds
review_timeout: 1200
fix_timeout: 1200
ci_timeout: 900
ci_poll_interval: 30
models:                          # planning/implementing/fix (implementer harness) are only
  planning: sonnet               # honored by claude — a key whose role runs on codex is
  implementing: sonnet           # ignored and a config warning is printed. review (reviewer
  review: claude-fable-5         # harness) is honored by both claude and codex. Each key also accepts "auto".
  fix: sonnet
effort:                          # per-phase reasoning effort — codex via -c model_reasoning_effort,
  planning: medium               # claude via --effort. Absent key: no flag. Each key also accepts "auto".
  implementing: low              # planning also sources plan-review's effort (classified separately).
  review: high                   # review is resolved round-aware (review-1 vs. review-2).
  fix: low
conventions_md_path: AGENTS.md   # excerpt embedded in prompts
domain_name: lyric-utils
domain_description: a quantitative finance Python library
```

If absent, defaults from `core/scripts/types.ts:DEFAULT_CONFIG` apply. By default the pipeline is harness-relative: the invoking host's profile supplies both roles (Codex primary + Claude Code secondary under the `codex` profile, and the reverse under `claude`). A repository can pin its own primary (implementer) and secondary (reviewer) harness pair, overriding the profile, via the optional `harnesses:` block:

```yaml
harnesses:
  implementer: grok   # primary: planning, implementation, fixes, pre-merge repair, intake, sweep
  reviewer: codex      # secondary: plan review, review rounds, pre-merge delta review, shipcheck, design gate
```

Either key may be omitted — an omitted role keeps the active profile's default for that role only. `implementer` must name a harness with a registered adapter (`claude`, `codex`, `grok`, `opencode`, `pi`); an unregistered name is rejected at config-parse time, naming the key, the value, and the registered adapter names, before any worktree is created. `reviewer` may additionally name an arbitrary custom reviewer CLI, same as the older `review_harness` key below.

The reviewer role MAY also be set (or overridden) via the optional `review_harness` key:

```yaml
review_harness: my-reviewer   # use a custom CLI as the reviewer instead of the profile default
```

When `review_harness` is set, the pipeline spawns `<value> "<prompt>"` and expects a JSON verdict on stdout (same schema as the built-in reviewers). If the CLI cannot be spawned, the item is blocked with an error naming the CLI explicitly, and the implementing harness is tried as a self-review fallback (established by #39). When both `harnesses.reviewer` and `review_harness` are set, they must agree — naming the same command is accepted (and `review_harness`'s structured model/effort/prompt-delivery settings still apply); naming different commands is rejected at config-parse time, naming both keys and both values.

`review_harness` also accepts a structured form for independent reviewer model/effort control, each accepting `"auto"` (resolved round-aware — plan-review/review-2 as Definitive, review-1 as Iterative):

```yaml
review_harness:
  command: claude
  model: auto
  effort: auto
```

## Conventions & carry-forward lessons

`readConventions` reads the target repo's conventions file (`conventions_md_path`, else `AGENTS.md` on this host) and injects an excerpt into **every** stage prompt — planning, plan-review, plan-revision, implementing, both review rounds, and both fix rounds — via the `{{conventions}}` placeholder. This makes the conventions file the natural home for **carry-forward lessons**: a maintainer-curated `## Lessons / Gotchas` section (or a dedicated lessons file pointed at by `conventions_md_path`) recording recurring findings and repo-specific hazards. It is ordinary conventions text, so it rides the existing injection with **no extra config key, store, or flag** beyond the `conventions_md_path` / `AGENTS.md` default.

The contract is **read-only**: no stage ever writes to, appends to, or creates the conventions file — the maintainer curates the lessons by hand and the pipeline carries them forward. A repo with no conventions file is unaffected (`readConventions` returns a benign stub and every stage proceeds).

## Run flow

For every invocation:

### 1. Resolve target
1. The numeric arg is fed to `gh api /repos/{repo}/issues/{N}` to detect
   issue vs PR. PRs follow the `closingIssuesReferences` link.
2. Refuse PRs without a closing reference.

### 2. Pre-flight checks
- **Kill switch** at `/tmp/pipeline-{domain}.disabled` — if present, exit.
- **Lock** at `/tmp/pipeline-{domain}.lock` — PID-based, auto-recovers stale.
- **Pipeline label gate** — refuses items without any `pipeline:*` label
  with a message explaining how to opt in (`pipeline:ready` manually).

### 3. Advance loop

```
while iter < 12 and not at ready-to-deploy and not blocked:
  read current stage from labels
  dispatch to the stage handler (planning, review, fix, pre_merge, …)
  print one-line transition
  if --once: break
```

Each iteration may block for up to ~20 minutes. Heavy implementation stages run
Codex against the full repo; review stages invoke the `claude` CLI directly with
the pipeline's JSON-returning review prompt. Worst-case full path is
9 transitions, ~2 hours.

### 4. Orchestration pattern (Codex-side, for default-mode advance)

A foreground command may run longer than normal interactive command windows,
especially when a planning/review/fix stage invokes a harness for up to about
20 minutes. For default advance mode, Codex must orchestrate the run as follows:

#### a. Status pre-check (fast, synchronous)

```bash
node ~/.codex/skills/pipeline/scripts/pipeline.mjs <N> --status
```

Confirms target exists, has a `pipeline:*` label, isn't already at a
terminal/blocked state. If anything looks wrong, surface it and stop —
do not start an advance.

#### b. Launch the advance through detached run-store mode

```bash
cd <repo_dir>
RUN_DIR=$(node ~/.codex/skills/pipeline/scripts/pipeline.mjs run <N> --detach)
cat "$RUN_DIR/run-store.json"
```

This command returns quickly. `RUN_DIR` is a supervision wrapper under
`~/.pipeline/runs/...`; `run-store.json` points at the canonical
`.agent-pipeline/runs/<run-id>/` run store. Use that `run_store_run_id` for all
log and summary commands below. Do not leave a live pipeline session running
when the Codex turn ends.

#### c. Poll structured run events

Follow the run-store event stream and summarize material lifecycle records to
the user:

```bash
node ~/.codex/skills/pipeline/scripts/pipeline.mjs logs <run-id> --events --follow
```

`--events` follows `.agent-pipeline/runs/<run-id>/events.jsonl`, the canonical
structured stream for lifecycle, gate, blocker, PR, review, accounting, and
completion events. It is not a grep-filtered terminal log and it is not a
separate `/tmp` transitions artifact.

**Fallback — raw terminal output:** If you need the full combined output, follow
`terminal.log` from the same run store:

```bash
node ~/.codex/skills/pipeline/scripts/pipeline.mjs logs <run-id> --follow
```

Do not create or recommend extra `/tmp/pipeline-<domain>-<N>.log` files for
normal monitoring. If a human manually redirects output for local debugging,
that file is scratch output, not the pipeline evidence contract.

#### d. User-visible progress updates

For every material event record, send a concise chat update. The state machine
has only a bounded number of stage transitions, so this gives enough signal
without flooding the user.

Examples that should be surfaced:
- `run_start`
- `stage_start`
- `stage_complete`
- `pr_created` / `pr_updated`
- `review_verdict`
- `gate_result`
- `blocker_set` / `blocker_cleared`
- `run_complete`

Examples to suppress or summarize:
- **Repeated polling-loop sub-events** — `pre_merge.advancePolling`
  re-enters the gate check every `ci_poll_interval` seconds (default 30s).
  Surface the first material stage/gate event per stage entry; suppress
  subsequent identical polling updates in the same burst. The next material
  event is the eventual advancing or blocked stage outcome.

#### e. Finish the run

When a `run_complete` event appears, or when the wrapper
`$RUN_DIR/sentinel.json` reports completion, stop polling and surface the final
summary.

#### f. Final summary

Read the run-store summary and surface inline:

```bash
node ~/.codex/skills/pipeline/scripts/pipeline.mjs summary <run-id>
```

Include starting stage, ending stage, transitions made, wall-clock elapsed, PR
URL if one was opened, and the terminal state.

### 4b. Orchestration pattern for `$pipeline:loop` (multi-item durable drive/resume)

Multi-item drive and resume via `$pipeline:loop` is **long-running** (minutes to
hours). It is **not** a seconds-only synchronous command. Do **not** treat it as
fire-and-forget without event following — use the same spirit as single-issue
advance (§4), against the loop event stream.

**Critical:** the terminal result JSON is printed only when the durable supervisor
**exits**. It is a final-summary surface, **not** a mid-flight handoff for a newly
started drive. For in-flight event following you need `run_id` **before**
completion — via early handoff (#665 when present), `--resume <run-id>`, or the
race-safe state-home discovery below.

#### a. Resolve state-home, then start or resume non-blocking

**State-home resolution order** (first set wins):

1. Explicit override: `AGENT_PIPELINE_STATE_HOME` (preferred) or legacy
   `PIPELINE_STATE_HOME`
2. `$XDG_STATE_HOME/agent-pipeline/loop` when `XDG_STATE_HOME` is set
3. Default: `~/.local/state/agent-pipeline/loop`

The loop CLI has no `--detach` yet. Until early handoff (#665) publishes
`run_id`/events path on stdout, start the supervisor **non-blocking** so the
harness can discover the run directory and follow events while it runs:

```bash
cd <repo_dir>
STATE_HOME="${AGENT_PIPELINE_STATE_HOME:-${PIPELINE_STATE_HOME:-${XDG_STATE_HOME:+$XDG_STATE_HOME/agent-pipeline/loop}}}"
STATE_HOME="${STATE_HOME:-$HOME/.local/state/agent-pipeline/loop}"
RUNS="$STATE_HOME/runs"
mkdir -p "$RUNS"
# Snapshot basenames already present (ignore staging dirs like *.init-*).
BEFORE=$(ls -1 "$RUNS" 2>/dev/null | grep -v '\.init-' || true)

# Prefer --resume when the operator already knows the id (no discovery needed).
# Otherwise start a new/continued drive. Use a unique result dir per invocation
# (mktemp) so concurrent loops never share stdout/stderr paths (#668).
LOOP_RESULT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pipeline-loop.XXXXXX")
LOOP_OUT="$LOOP_RESULT_DIR/out.json"
LOOP_ERR="$LOOP_RESULT_DIR/err.txt"
node ~/.codex/skills/pipeline/scripts/pipeline.mjs loop --milestone <name> \
  >"$LOOP_OUT" 2>"$LOOP_ERR" &
# or: ... loop --resume <run-id> ...
# or: ... loop <N> <N> ...
LOOP_PID=$!
# Process-instance identity so a recycled PID after launcher exit cannot keep
# discovery alive (#668). Platform backends:
#   Linux: /proc/<pid>/stat starttime (clock ticks)
#   Darwin/other: ps -o lstart= (stable for the process lifetime)
process_starttime() {
  local pid="$1" out
  if [ -r "/proc/$pid/stat" ]; then
    out=$(node -e 'const fs=require("fs");const pid=process.argv[1];let s;try{s=fs.readFileSync("/proc/"+pid+"/stat","utf8");}catch{process.exit(1)}
const i=s.lastIndexOf(")"); if(i<0)process.exit(1); const f=s.slice(i+2).trim().split(/\s+/);
if(!f[19])process.exit(1); process.stdout.write(f[19]);' "$pid" 2>/dev/null) && [ -n "$out" ] && { printf '%s' "$out"; return 0; }
  fi
  out=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -n "$out" ] && printf '%s' "$out"
}
LOOP_START=$(process_starttime "$LOOP_PID") || { echo "failed to capture launcher starttime"; wait "$LOOP_PID"; exit 1; }
```

On a preflight failure the process exits quickly with printed remediation on
stderr — do not start any substitute loop. If `$LOOP_PID` exits (or its
starttime changes — PID reuse) before a run directory is mapped, read
`$LOOP_ERR` and stop. Do not leave a live supervisor unobserved when the Codex
turn ends without an event-follow plan.

#### b. Obtain `run_id` + loop events path (before completion)

**Order of preference:**

1. **Early handoff** when present (stdout/JSON carrying at least `run_id` and a
   loop events path — #665). Prefer this over filesystem discovery.
2. **`--resume <run-id>`** (or an operator-known id): use that `run_id`
   immediately; begin following before or right after launching.
3. **Race-safe state-home discovery** for a newly started or selector-continued
   drive (no early handoff, no resume arg). Snapshot `$BEFORE` so concurrent
   publishes are visible, then **scan every candidate** under `$RUNS/` each poll
   (ignore `.init-*` staging). Select **only** a directory that has both
   `contract.json` and `events.jsonl` **and** a live `lock.json` whose `pid`
   is **exactly** `$LOOP_PID` as an integer, **or** a process-tree **descendant**
   of `$LOOP_PID` (walk parents of the lock pid until match), **and** the
   launcher is still the **same process instance** captured at launch
   (`$LOOP_PID` + `$LOOP_START` starttime — not merely `kill -0`, which is
   true after PID reuse). Ownership is **numeric identity only** — never
   string/grep prefix matching (`123` must **not** match lock pid `12345`).
   **Never** break on the first newly published basename (glob order is not
   ownership). If one or more new directories exist without a lock owned by
   this launch, keep polling until a lock match appears or the launcher
   instance is gone (exit or PID reuse).

```bash
# Pseudocode — poll until mapped or THIS launch instance is gone.
# NEVER unanchored grep of "$LOOP_PID" (prefix false match).
# NEVER trust kill -0 alone (PID reuse after launcher exit).

process_starttime() {
  local pid="$1" out
  if [ -r "/proc/$pid/stat" ]; then
    out=$(node -e 'const fs=require("fs");const pid=process.argv[1];let s;try{s=fs.readFileSync("/proc/"+pid+"/stat","utf8");}catch{process.exit(1)}
const i=s.lastIndexOf(")"); if(i<0)process.exit(1); const f=s.slice(i+2).trim().split(/\s+/);
if(!f[19])process.exit(1); process.stdout.write(f[19]);' "$pid" 2>/dev/null) && [ -n "$out" ] && { printf '%s' "$out"; return 0; }
  fi
  out=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -n "$out" ] && printf '%s' "$out"
}

# Still the same OS process we launched (pid + starttime). Works on Linux and Darwin.
launcher_instance_alive() {
  kill -0 "$LOOP_PID" 2>/dev/null || return 1
  cur=$(process_starttime "$LOOP_PID") || return 1
  [ "$cur" = "$LOOP_START" ]
}

lock_pid_from_json() {
  node -e 'const fs=require("fs");let j;try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));}catch{process.exit(2)}
const p=j&&j.pid; if(typeof p==="number"&&Number.isInteger(p)&&p>0){process.stdout.write(String(p));process.exit(0)}
if(typeof p==="string"&&/^\d+$/.test(p)){process.stdout.write(p);process.exit(0)} process.exit(1)' "$1" 2>/dev/null \
  || sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1" | head -1
}

lock_owned_by_launcher() {
  local lock_pid="$1" launcher="$2" cur parent
  case "$lock_pid" in ''|*[!0-9]*) return 1 ;; esac
  case "$launcher" in ''|*[!0-9]*) return 1 ;; esac
  cur=$lock_pid
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32; do
    [ "$cur" -eq "$launcher" ] 2>/dev/null && return 0
    [ "$cur" -le 1 ] 2>/dev/null && return 1
    parent=$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' ')
    case "$parent" in ''|*[!0-9]*) return 1 ;; esac
    [ "$parent" -eq "$cur" ] 2>/dev/null && return 1
    cur=$parent
  done
  return 1
}

RUN_ID=""
while launcher_instance_alive; do
  for d in "$RUNS"/*; do
    [ -d "$d" ] || continue
    base=$(basename "$d")
    case "$base" in *.init-*) continue ;; esac
    [ -f "$d/contract.json" ] && [ -f "$d/events.jsonl" ] || continue
    [ -f "$d/lock.json" ] || continue
    lock_pid=$(lock_pid_from_json "$d/lock.json") || continue
    case "$lock_pid" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$lock_pid" 2>/dev/null || continue
    launcher_instance_alive || break
    if lock_owned_by_launcher "$lock_pid" "$LOOP_PID"; then
      RUN_ID=$base
      break
    fi
  done
  [ -n "$RUN_ID" ] && break
  sleep 0.5
done
```

4. **Terminal result JSON** (`$LOOP_OUT` after process exit) —
   use only for the **final summary**, not as the sole mid-flight source of
   `run_id` for a new drive.

Then resolve the events file:

```text
<state-home>/runs/<run_id>/events.jsonl
```

#### c. Follow the loop event stream

Poll or follow the loop events file **as soon as** `run_id` is known (step b) —
do not wait for supervisor exit — and summarize material lifecycle records.
Prefer the first-class CLI (exits 0 on `loop_run_stopped` by default):

```bash
node ~/.codex/skills/pipeline/scripts/pipeline.mjs loop logs <run_id> --events --follow
# default until-terminal: process exits 0 after loop_run_stopped
# interrupt-only dashboards: add --no-until-terminal
```

**Do not** use a bare `tail -F` on `events.jsonl` as a follow fallback: it never
exits after `loop_run_stopped`, prints no final summary, and leaves zombie
follows. Prefer the CLI above. Dual-follow / multi-stream scripts **must
`exit 0`** after observing `loop_run_stopped` and printing a final summary line
(do not print `TERMINAL` inside `while true` and keep looping). Any raw tail
must **explicitly track** its tail child PID and **TERM/KILL** that child on
terminal — process substitution + bare `exit 0` orphans `tail -F`. Example
terminal-aware raw fallback (explicit child teardown; prefer the CLI):

```bash
# Prefer: pipeline loop logs <run_id> --events --follow  (auto-exits on terminal)
EVENTS="<state-home>/runs/<run_id>/events.jsonl"
# Process substitution alone does NOT kill tail -F on exit — track + TERM/KILL.
# Private dir + FIFO inside it (never mktemp -u: TOCTOU clobber hazard).
FIFO_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pipeline-loop-follow.XXXXXX") || exit 1
FIFO="$FIFO_DIR/events.fifo"
mkfifo "$FIFO" || { rmdir "$FIFO_DIR" 2>/dev/null; exit 1; }
tail -n +1 -F "$EVENTS" >"$FIFO" &
TAIL_PID=$!
stop_tail() {
  [ -n "${TAIL_PID:-}" ] || return 0
  kill -TERM "$TAIL_PID" 2>/dev/null || true
  sleep 0.1
  kill -KILL "$TAIL_PID" 2>/dev/null || true
  wait "$TAIL_PID" 2>/dev/null || true
  TAIL_PID=""
  rm -f "$FIFO"
  rmdir "$FIFO_DIR" 2>/dev/null || true
}
trap stop_tail EXIT INT TERM
while IFS= read -r line; do
  printf '%s\n' "$line"
  case "$line" in
    *'"kind":"loop_run_stopped"'*|*'"kind": "loop_run_stopped"'*)
      reason=$(printf '%s' "$line" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      echo "TERMINAL reason=${reason:-stopped}; follows stopped"
      stop_tail
      trap - EXIT INT TERM
      exit 0
      ;;
  esac
done <"$FIFO"
```

Never forbid background following or event streaming for drive/resume.

#### d. Dual-follow: MUST arm advance events after linkage (mandatory until #611)

When a loop event of kind `loop_item_advance_linked` (or equivalent start
linkage) publishes an active item's advance `pipeline_run_id` and/or absolute
advance `events` path, the harness **SHALL** arm a follow on that advance event
stream **in addition to** the loop stream (dual-follow). This is **not**
optional: mid-item stage progress (planning → implement → review → pre-merge)
lives on the **advance** `events.jsonl`, not on the sparse loop stream, until
first-class stage progress is mirrored onto the loop stream (#611; pre-merge
density #682).

**Preferred follow target** (when `pipeline_run_id` is known):
When an item's advance run is linked (`loop_item_advance_linked` carries
`item_id`, `pipeline_run_id`, and an absolute `events` path), **material
pre-merge gate outcomes are already mirrored onto the loop stream** as
`loop_item_progress` (CI waiting/pass/fail, OpenSpec archive, delta review,
auto-fix, terminal blocked/advanced) while linkage is active — hosts do
**not** need advance-only follow solely to learn those gate results (#682).

Optionally still follow the linked advance `events.jsonl` for full-fidelity
stage/harness detail (accounting, raw review findings, etc.):

```bash
node ~/.codex/skills/pipeline/scripts/pipeline.mjs logs <advance-run-id> --events --follow
```

The absolute `events` path from the linkage record is an acceptable alternative
target (e.g. `tail -F` or host-equivalent follow on that file).

**Before linkage exists:** continue loop-only follow — do **not** require a
non-existent advance-linkage field.

**Follow lifecycle:**

1. **Arm** advance follow when linkage publishes `pipeline_run_id` / `events`.
2. On a **new item's** advance linkage, **switch or add** follow for the new
   advance run; **stop** the prior item's advance follow on that item's terminal
   advance outcome (e.g. `run_complete`) rather than leaving stale follows open.
3. Keep the **loop** event stream follow active across item boundaries until a
   terminal loop outcome or supervisor process exit.

**Material advance kinds** to surface (same spirit as single-issue §4):

- `stage_start`
- `stage_complete`
- `pr_created`
- `review_verdict`
- `gate_result`
- `blocker_set`
- `run_complete`

**Suppress** pure CI poll spam — including repeated identical
`pre_merge.advancePolling`-style updates in the same burst (surface the first
material stage/gate event; wait for the eventual advance/block outcome).

**Loop-only follow** remains valid for schedule, hold, and terminal **loop**
kinds (`loop_schedule_evaluated`, holds, `loop_run_stopped`, …), but is
**insufficient alone** for mid-item stage progress until #611 ships. When #611
makes the loop stream carry first-class stage progress, this dual-follow
mandate **MAY** be demoted to optional / “recommended for full fidelity” in
that same PR (with host skill + living-spec updates together). Do **not** demote
solely for quieter notifications while the loop stream is still sparse.

#### e. User-visible progress on material loop events

**Must surface** (chat update):

- `loop_item_started`
- `loop_item_transitioned`
- `loop_item_blocked`
- `loop_run_stopped`

**Should surface** when present (not spam):

- `loop_item_progress` — shared progress kind; for `domain: "pre_merge"`, notify
  on definitive outcomes (`pass`, `fail`, `approve`, `needs_attention`,
  `attempted`, `success`, `exhausted`, `blocked`, `advanced`) and the **first**
  `waiting` for a CI stretch. Material pre-merge gate sub-steps (CI, OpenSpec
  archive, delta review, auto-fix, terminal) appear on the **loop** stream
  while the item is advance-linked — do not require advance-only logs for those.
- `loop_schedule_evaluated` — only on a **decision change**, not every identical
  poll in a burst
- `loop_reconciled` / `loop_merge_barrier_cleared`
- `loop_item_paused` / `loop_item_waiting` / `loop_item_resumed`
- `loop_item_abandoned` / `loop_item_skipped` / `loop_item_precondition_excluded`
- `loop_recovery_attempt`
- `loop_run_superseded`

**Suppress:** pure heartbeats and repeated identical schedule/reconcile
evaluations in the same burst (same spirit as suppressing
`pre_merge.advancePolling` in §4). Do not re-surface every identical
`loop_item_progress` CI waiting poll after the first for a stretch.

#### f. Stop following (same turn — mandatory)

When a material **`loop_run_stopped`** event is observed for the followed
`run_id`, **or** when the supervisor process for that run exits: **in the same
harness turn**, stop **all** loop event follows/tails **and** all advance event
follows started for that loop run (including dual-follow / multi-stream tails).
Do **not** leave those follows running until the operator asks to kill them.
Do **not** kill follows for other issues, other run ids, or session tools
unrelated to that loop `run_id` / its published advance run ids.

Documented dual-follow scripts **exit 0** after `loop_run_stopped` and a final
summary line — they must not continue an infinite follow loop after terminal.
Stop polling/tailing the loop stream when a terminal loop outcome appears —
especially `loop_run_stopped` — or when the supervisor process exits. Stop (or
replace) the active item's advance follow on that item's terminal advance
outcome when switching items or when the advance run completes; do not leave
unbounded stale advance follows open.

#### g. Final summary / audit

Surface the run's terminal state. Prefer the printed JSON result; for a
read-only process/timeline report:

```bash
node ~/.codex/skills/pipeline/scripts/pipeline.mjs loop --resume <run-id> --audit
# stage table + optional whole-run stage-progress follow (not harness stdout):
node ~/.codex/skills/pipeline/scripts/pipeline.mjs loop --resume <run-id> --audit --follow
```

The final operator summary **must** include (1) the run's **terminal reason**
(or equivalent stop reason from the terminal event / result JSON) and (2)
explicit confirmation that run-scoped follows were stopped (e.g. **follows
stopped**).

### 5. Modes that DON'T need this orchestration

- `--status` — read-only, completes in seconds
- `--unblock "<answer>"` — one comment + label clear, completes in seconds
- `--dry-run` — logs what would happen, no harness calls
- `--cleanup` — sweeps merged-PR worktrees, prints a summary, completes in seconds
- `--init` — ensures labels + scaffolds `.github/pipeline.yml`, completes in seconds
- `config sync` — previews/applies a validated `.github/pipeline.yml` scaffold refresh, completes in seconds
- `config repo-map <add|remove|list>` — mutates/lists `repo_map` entries, completes in seconds
- `doctor` — deterministic preflight, no model calls, completes in seconds
- `$pipeline:loop --audit` — read-only report (stage table) for a durable run; synchronous, no event-follow
- `$pipeline:loop --resume <run-id> --audit --follow` — read-only stage-progress stream; no run-liveness lock

Run those synchronously without the PTY/log-polling orchestration.

**Not in this list:** multi-item `$pipeline:loop` drive or resume (with or without
`--milestone` / issue lists / `--resume`) — those use §4b long-running
orchestration. Do not apply the seconds-only / no-follow rule to drive/resume
just because `--audit` is fast.

`--once` still needs the orchestration because a single heavy stage
(planning especially) can hit its 20-minute timeout. Use the same PTY/log
polling pattern as default mode; just expect at most one transition before the
run exits.

### 6. Optional HTML report artifact

For multi-stage runs, blocked runs with substantial context, or any run whose final state is easier to understand visually, generate a self-contained HTML report in `artifacts/reports/pipeline-<N>.html` inside the target repo/worktree. Keep the chat summary short and include the artifact path.

The report should include:
- stage timeline
- issue/PR links
- branch and worktree path
- changed files
- review findings
- CI/check status
- blockers or terminal state

HTML report constraints: inline CSS/SVG/JS only; no external scripts, stylesheets, CDNs, tracking, network calls, or remote assets. If the report includes interactive controls, include a copy/export block that serializes the selected state back to Markdown/JSON/prompt text.

Do not create HTML for simple `$pipeline N --status`, `--dry-run`, or one-step summaries unless the user asks.

### 7. Final summary

When the loop ends, the skill prints:
- Starting stage → ending stage
- Number of transitions
- Wall-clock elapsed
- For terminal: PR URL + ready-to-deploy summary
- For blocked: latest blocker comment + the unblock command
- For waiting: short reason + "re-run $pipeline N when ready"

## Failure modes

- **`gh` not authenticated** → tell user `gh auth login`, exit.
- **No git repo at cwd / repo-path** → exit 2 with "run from inside a checkout".
- **Issue # doesn't exist** → surface `gh` error, exit 1.
- **PR has no linked issue** → refuse with the explanation.
- **No `pipeline:*` label** → refuse with opt-in instructions.
- **Stage handler error** → posts a `blocked` label + structured comment
  with reason; loop terminates and shows the latest blocker.
- **Codex implementation fails (planning/implementation/fix)** → blocked.

## What this skill never does

- Auto-merge PRs autonomously — the advance loop never merges and there is no `auto_merge` config key. The human-invoked `$pipeline merge <pr>` command is the controlled, explicit surface for merging after `pipeline:ready-to-deploy`; it is never called by the advance loop. `$pipeline:merge-queue --milestone <m>` is a dry-run planner only (ordered R2D candidates); it never merges and is never called by advance.
- Bypass the `pipeline:*` opt-in label gate.
- Run more than one transition under `--once`.
- Touch the GitHub repo in `--dry-run` mode.
- Read or send `ANTHROPIC_API_KEY`.
- Write outside the repo's worktree directory or the target issue/PR.

## Reference

- `core/scripts/types.ts` — STAGES, PipelineConfig, Outcome, ReviewVerdict
- `core/scripts/config.ts` — load `.github/pipeline.yml` + defaults
- `core/scripts/gh.ts` — typed wrappers for the `gh` CLI
- `core/scripts/worktree.ts` — `pipeline-{N}-{slug}` worktree lifecycle
- `core/scripts/harness.ts` — invokes Codex for implementation and provides shared process helpers
- `core/scripts/stages/review.ts` — invokes the `claude` CLI directly with the pipeline's JSON-returning review prompt
- `core/scripts/lock.ts` — PID-based lock at `/tmp/pipeline-{domain}.lock`
- `core/scripts/stages/*.ts` — one file per stage (planning, review, fix, pre_merge, eval, deploy_ready, auto_recover)
- `core/scripts/prompts/*.md` — prompt templates with `{{placeholders}}`
- `core/scripts/pipeline.ts` — top-level orchestrator + CLI
- `README.md` — human-facing docs
