---
name: pipeline
description: |
  Use this skill whenever the user wants to advance a GitHub issue or PR
  through a label-driven dev pipeline toward `pipeline:ready-to-deploy`.
  Triggers include phrases like "pipeline issue 419", "push #360 forward",
  "advance this PR through review", "run the pipeline on <issue>", or the
  `/pipeline` slash command. Do NOT use this skill for: general PR review
  (use /review), backlog triage/cleanup (use /sweep), or deploying a finished
  item (deployment is out of scope — the pipeline stops at ready-to-deploy).
---

# pipeline

Self-contained TypeScript skill that advances a GitHub issue (or PR's linked
issue) through a 17-stage label-driven state machine, ending at
`pipeline:ready-to-deploy` on the happy path (or parking at `pipeline:needs-human`
when review ceilings / similar paths exhaust). The ordinary advance path never
merges. Merge commands require separate operator authority.

## Developing this skill itself (core/ → plugin/ mirror)

When the work target is the agent-pipeline repo — any implementation, fix, or
test-fix step that edits a file under `core/` — `plugin/` is a generated mirror
of `core/` (+ `hosts/claude`). After editing any file under `core/`, run
`node scripts/build.mjs` from the repo root and include the regenerated
`plugin/` in the same commit. A core-only commit fails CI's
`build.mjs --check` gate and burns a fix-loop attempt on the stale mirror.

## State machine

Happy path (16 stages total in code `STAGES`, including the park off-ramp):

```
backlog → ready → planning → plan-review → pre-code-attestation → implementing → design-gate
              → review-1 → fix-1 → review-2 → fix-2
              → pre-merge → visual-gate → eval-gate → shipcheck-gate
              → ready-to-deploy
```

Terminal off-ramp (not a happy-path successor of `ready-to-deploy`):

```
… review ceilings / exhaustion → needs-human
```

Each item carries one `pipeline:<stage>` label and at most one `blocked`
label. Stage transitions are driven by structured outcomes from the stage
handlers in `scripts/stages/`. The skill **owns** the labels — it sets,
removes, and transitions them as side-effects of running the underlying
stage logic. There is no separate orchestrator process.

`backlog` is a triage marker (e.g. set by `/sweep`). `/pipeline` starts work
at `ready` and only acts on items that already carry a `pipeline:*` label.
`needs-human` is a terminal park state (review-ceiling punch list, etc.); the
advance loop never auto-advances from it to `ready-to-deploy`.

### Merge authority boundary

`/pipeline`, `/pipeline:single`, and `/pipeline:loop` never invoke merge.
`/pipeline:merge <pr>` and `/pipeline:merge-queue --apply` are loop-isolated,
operator-authorized surfaces. `merge-queue` is dry-run by default.

External supervisors may invoke those same loop-isolated merge commands
under operator authority. This repository does not ship a Hermes/Buzz factory
control plane, grant schema, or second durable scheduler. Merge authority is
not repository configuration (`.github/pipeline.yml` cannot authorize merges).
Do not add an `auto_merge` key or merge stage. In the current Grok factory
profile, Grok planning, implementation, and fixes use only `grok-4.5`, with no Grok fallback. Codex performs review.

## Modes

The primary invocation is the advance loop; all other operations are available as
distinct `pipeline:<command>` entries in the skill/command menu.

<!-- BEGIN GENERATED: cli-command-table -->
```
/pipeline N                                     durable autonomous one-item drive (default)
/pipeline loop --milestone <m>|--label <l>|--range a-b [--resume <run-id>] [--audit] [--follow] Durable multi-item run — driven in-repo by the pipeline's own loop supervisor
/pipeline run <n> [--detach]                    Advance alias; use with --detach for a legacy raw detached run (desktop launchers)
/pipeline single <n>                            Canonical durable one-item autonomous drive (owns a durable loop; delegates stages to advance)
/pipeline cleanup                               Sweep merged-PR worktrees and delete their local branches
/pipeline doctor [--json|--is-ok] [--fail-fast] [--harness-smoke] Deterministic preflight check; print summary, exit 0/1. Opt-in --harness-smoke adds one cheap model call per unique configured harness treatment
/pipeline init                                  Ensure pipeline labels and scaffold .github/pipeline.yml
/pipeline merge <pr>                            Operator-authorized squash merge of a ready-to-deploy PR (never called by the advance loop)
/pipeline merge-queue --milestone <m> [--apply] [--release-when-complete --release-version <ver>] Operator-authorized sequential merge of ready-to-deploy PRs; dry-run by default; optional prepare-only release-when-complete
/pipeline override <n> "<key>: <reason>"        Disposition a review finding and auto-resume the advance loop
/pipeline release <version> [--theme "..."] [--dry-run|--json] [--no-edit] [--skip-frg] | release finish <pr> [--json] Prepare a release PR from the matching GitHub milestone plan (or finish-merge one); never tags or publishes (workflows do; auto-tag also refreshes tag-derived CHANGELOG); --dry-run reports milestone presence/open issues
/pipeline remove-worktree <n> [--force]         Remove a managed pipeline worktree for an issue (optional --force)
/pipeline ship --milestone <m> --for <X.Y.Z> --authorization <absolute-json> --json | ship status --milestone <m> --for <X.Y.Z> --json Run or inspect one exact, Buzz-authorized release shipment through train, FRG, release, and engine promotion
/pipeline status <n>                            Read-only — print stage, blocker, PR, last review
/pipeline train --milestone <m>|--issues <n,n> [--merge] [--json] Operator-authorized integrate train: base-eligible frontiers advance via one loop wave each (recovery inside the wave); optionally serial-merge with base containment; independent R2D siblings may merge while a peer is parked (never called by the advance loop)
/pipeline unblock <n> "<answer>"                Post an answer and clear the blocked label
/pipeline backfill [--apply] [--capability <name>] Preview or apply OpenSpec coverage for legacy behavior (spec-only PR)
/pipeline decompose --epic <N> [--description "…"] [--apply] [--release vX.Y.Z] [--max-children N] [--max-effort S|M|L|XL] [--allow-xl] Break an epic issue into dependency-linked child issues and a ROADMAP PR (dry-run default; --apply writes; not intake / not roadmap-order-only / not loop-execute)
/pipeline engine-promote --for <X.Y.Z> [--host all|codex|claude|grok|opencode] [--dry-run] [--json] [--skip-install] Self-host: verify published release, promote production pin, install exact tag to all hosts by default, verify version (rollback pin on install failure)
/pipeline evals plan|run|grade|report|harvest … Offline eval plan/run/grade/report/harvest (never writes to production GitHub)
/pipeline factory-gate --for <version> [--from-run <run-id>] [--observations <file>] [--scenario id=status:detail] [--promote-pin-on-pass] Score a durable loop / fixture pack and write immutable FRG evidence (never merges or tags)
/pipeline factory-pin show|init --from-frg <X.Y.Z>|promote --for <X.Y.Z>|rollback [--to <X.Y.Z>] [--git-sha <sha>] [--force] Show / init / promote / rollback the factory production engine pin (last FRG-passed release; never merges or tags)
/pipeline factory-release prepare --request <absolute-request.json> --json Durable post-pilot FRG generation + prepare-only release handoff (two-call: awaiting_frg_attestation → complete; never merges/tags)
/pipeline improve [--apply] [--top <n>] [--json] Cluster papercuts / corrections / durable-run blockers into backlog candidates
/pipeline intake --description "<text>" [--release vX.Y.Z] [--dry-run] Spec a rough description into a GitHub issue and ROADMAP PR
/pipeline queue [--max-issues <n>] [--concurrency <n>] [--budget-dollars <d>] Batch factory: dispatch all pipeline:ready issues up to concurrency/budget limits
/pipeline refine-spec --title "<t>" --body "<b>" Refine an existing issue's spec; non-mutating JSON output
/pipeline roadmap [--apply] [--next <n>]        Analyze open backlog into a dependency-aware scored roadmap; under SemVer, dry-run lists full milestone reconciliation actions and --apply converges open issues to the reviewed manifest (fingerprint-gated)
/pipeline sweep [--apply] [--repo owner/name]   Batch re-spec thin issues and reconcile ROADMAP.md
/pipeline triage <n> --stage ready|backlog      Set a pre-pipeline stage label (ready or backlog) on an issue
/pipeline controls check [--json] [--strict]    Read-only repository-control drift check against configured desired state (#695); never mutates forge settings
/pipeline correction record|attribute …         Record a correction event or attribute a control (append-only local ledger)
/pipeline logs [<run-id>] [--events] [-f] [--no-until-terminal] List or stream pipeline run logs (events --follow exits 0 on terminal run_complete)
/pipeline outcomes ingest|list [--adapter github] [--fixture <path>] [--days <n>] [--retention-days <n>] [--dry-run] [--json] Ingest or list production/rework outcomes linked to pipeline runs (host-local store; #576). R2D alone is never production delivery; free text is redacted; no GitHub mutations
/pipeline report [--yes]                        Privacy-safe product-fault report preview/submit (optional; off by default in config)
/pipeline scoreboard [--days <n>|--since <iso>] [--until <iso>] [--bucket day|week] [--by <dim>] [--json] [--html <path>] Print read-only factory throughput/cost/reliability metrics from run artifacts (incl. human-touch, escape-recurrence, discovery-channel, stratified stabilization; #763; production outcomes #576)
/pipeline summary <run-id>                      Print the run evidence bundle for an issue number or exact run-id
/pipeline config schema|validate|sync|repo-map … Config schema, validate, sync scaffold, and repo-map mutations
/pipeline path [--json]                         Discover installed host skill paths (JSON-friendly for desktop integrators)
/pipeline handoff list|show|answer|reject|supersede … [--json] [--issue N] [--run-id id] [--status pending] List, inspect, answer, reject, or supersede durable human-question handoffs (#647)
```
<!-- END GENERATED: cli-command-table -->

**Deprecated flag forms** (still work, emit a one-line deprecation notice to stderr):
```
/pipeline N --status        → use /pipeline:status N
/pipeline N --summary       → use /pipeline:summary N
/pipeline N --unblock "…"   → use /pipeline:unblock N "…"
/pipeline N --override "…"  → use /pipeline:override N "…"
/pipeline --init            → use /pipeline:init
/pipeline --cleanup         → use /pipeline:cleanup
```

The number is auto-detected as an issue or PR via the GitHub API. PRs are
resolved to their linked closing issue (the pipeline is issue-centric). PRs
without a `Closes #N` reference are refused with an explanation.

`/pipeline:loop` is the canonical command for a **durable** multi-item run —
one that is expected to span sessions or engines. It runs a deterministic,
read-only preflight in this skill (argument normalization,
`loop:store-schema-compatibility`, native-`/goal` capability), then drives the
run — contract, ledger, lock, recovery, reconciliation, resume — entirely
in-repo through this skill's own durable loop supervisor. It never discovers,
requires, or invokes an externally installed goal-loop skill, and it never
sets a stage label or merges itself; every selected item still executes
through this skill's own state machine and evidence gates via the
`pipeline/loop-execution@1` hand-off contract. It refuses to start (with zero
durable writes) when the engine's built-in autonomous `/goal` mode is
unavailable — there is no non-durable fallback loop. Multi-item drive is
**long-running** (foreground for the whole wall-clock of the run): on
successful create/resume and exclusive lock, before the first item dispatch,
the CLI emits an early machine-readable stdout JSON line
(`kind: "loop_run_handoff"`) with `run_id` and the absolute `events` path so a
harness can follow structured progress; a terminal summary JSON is printed
when the supervisor finishes. `--resume <run-id>` takes over a run whose prior
supervisor is provably gone; a run whose supervisor is still alive is refused
rather than double-driven. `--audit` renders the run's process identity,
action-evidence timeline, watchdog/no-progress state, and a **per-item
stage-progress table** (stage + optional round + advance run-id drill-down)
with zero durable writes (no drive handoff). Combine with `--follow`
(`--resume <run-id> --audit --follow`) to stream clean one-line stage
transitions for the whole run — not interleaved harness stdout. A pre-existing
run created by a legacy goal-loop invocation remains addressable by
`--resume <run-id>` (read-only import).

The native-`/goal` check never treats an absent marker in `claude --help` as
evidence the capability is missing (`/goal` is a slash command, not a CLI
flag). It resolves an operator attestation (`loop.native_goal_attestation:
available | unavailable` in `.github/pipeline.yml`, overriding everything
else) first, then a positive `--help` marker, then a documented version floor
against `claude --version`. A failure names the detected version, the
required floor, and the attestation key (#506).

#### Bootstrapping a durable run: native `/goal` then `/pipeline:loop`

Starting a durable run is an **operator-owned, two-step bootstrap** performed
inside a Claude Code session:

1. Run `/goal` to enter Claude Code's built-in autonomous mode.
2. Inside that `/goal` session, invoke `/pipeline:loop …` to start the durable
   run.

This skill does **not** detect whether `/goal` is active — the native-`/goal`
check above only probes the *capability* (attestation, `--help` marker,
version floor), not live session state. This skill does **not** invoke or
re-enter `/goal` itself; entering `/goal` is the operator's action, taken
before `/pipeline:loop` is ever run. And this skill does **not** control the
native `/goal` session's lifecycle: `/goal` is the outer autonomous driver,
`/pipeline:loop` is the durable workload it runs inside that driver.

Native completion is likewise a **host/user action**. `/pipeline:loop` reports
its own terminal done and reconciliation conditions from the durable loop
engine (see `--audit` above); ending the native `/goal` session afterward is
something the operator or Claude Code's `/goal` mode does, not something this
skill performs. Consistent with the pipeline never merging, this skill neither
ends the `/goal` session nor merges once a run reports done.

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
additive — a normal `/pipeline N` run still self-creates any missing labels, so
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

`doctor` takes no number either. By default it runs a **deterministic, model-free**
preflight that checks required CLIs (`gh`, `node`), GitHub auth + repo access,
worktree cleanliness on protected branches, configured harness availability, npm
install freshness, whether the installed engine version is behind the latest
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

**Opt-in harness smoke (`--harness-smoke`, #780):** after the static checks,
doctor may also run a role-aware, treatment-exact runtime smoke for every unique
configured `{adapter, role, model, effort}` coordinate (~**one cheap model call
per treatment**). Implementer smoke proves spawn + trailer-bearing commit +
stage-output contract + optional telemetry in a throwaway scratch repo; reviewer
smoke proves a structured read-only verdict with **no** repository mutation
(reviewer-only adapters are not required to commit). Readiness/`runtimeSmoke`
hooks run first and short-circuit a treatment without a model call when possible.
Default `pipeline doctor` (flag absent) remains model-free.

**Doctor vs production preflight-on-invoke (#636):** doctor is optional
run-start readiness (coarse assigned-adapter / host capability checks). It is
**not** a substitute for the mandatory per-invocation gate: every production
local-CLI harness model call (implementer and reviewer) still preflights the
**exact resolved** adapter, role, model, effort, sandbox/tool policy, prompt
byte limit, and executable readiness before spawn — even when
`doctor.runOnStart` is false. Unsupported or unavailable settings fail closed
with typed remediation; the pipeline never falls back to another harness or an
ambient model default.

`intake` turns a rough one-line description into a decision-complete GitHub issue
**and** a matching `ROADMAP.md` update — in one command:

```bash
/pipeline intake --description "add retry logic to the fix loop"
/pipeline intake "add retry logic" --release v1.6.0
/pipeline intake --description "add retry logic" --dry-run   # preview only
```

The spec-generation step is the only model call; issue creation and roadmap editing
are deterministic. The roadmap update is opened as a PR for human review — the
pipeline never merges. `--release vX.Y.Z` pins the target slot; omitting it
proposes the first open lane from `ROADMAP.md`.

`decompose` is the **epic work-breakdown** command: one parent epic → N small
dependency-linked children + a ROADMAP PR. It is **not** intake (1→1), **not**
roadmap (order existing inventory), and **not** loop (execute). Dry-run is the
default; `--apply` creates children and opens a ROADMAP PR (never merges).

```bash
/pipeline decompose --epic 123                         # preview child graph (no writes)
/pipeline decompose --epic 123 --description "prefer API slices"
/pipeline decompose --epic 123 --apply --release v1.43.0
/pipeline decompose --epic 123 --apply --max-children 12 --max-effort M
```

Child triage: decision-complete bodies get `pipeline:ready`; remaining open
questions get `pipeline:backlog`. The parent stays open as umbrella, is labeled
`pipeline:epic`, and is **excluded from default milestone/label loop selectors**
(explicit issue lists may still name it). Compose next with
`/pipeline loop --milestone <lane>` or merge-queue after children reach R2D.

`refine-spec` is a **non-mutating** spec-refinement preview command. It accepts
an existing issue's title and body and returns a refined spec as JSON — no GitHub
writes, no git writes, no filesystem writes:

```bash
/pipeline refine-spec --title "Add retry logic" --body "## Summary\nA retry mechanism."
# → {"title":"...","body":"## Summary\n...","milestone":null}

pipeline refine-spec --help   # probe: exits 0 only on installs that support this contract
```

The output object always contains `title` (string), `body` (string), and `milestone`
(string or null). The `body` field follows the WHAT-not-HOW section contract: Summary,
User story, Acceptance criteria, Out of scope, and Open questions only when genuinely
ambiguous. `--json` is accepted for callers that pass it; behavior is identical (output
is always JSON). Re-running on the same input leaves all repo and GitHub state unchanged.

`triage` sets a pre-pipeline stage label on an issue — no model call, fully
deterministic:

```bash
/pipeline triage 42 --stage ready     # promote to pipeline:ready
/pipeline triage 42 --stage backlog   # move back to pipeline:backlog
```

Only `ready` and `backlog` are settable via `triage`. The command is idempotent
(re-running when already set is a no-op). Mid-flight stages owned by the advance
state machine are rejected with a clear error.

`sweep` is the **batch** companion to `intake`: it re-specs every thin issue in
the existing backlog and reconciles `ROADMAP.md` in one pass:

```bash
/pipeline sweep                  # preview what would change (no writes)
/pipeline sweep --apply          # apply: update issues + open ROADMAP PR
/pipeline sweep --apply --repo owner/repo   # target a different repo
```

Default is preview-only (dry-run). With `--apply`: thin issue bodies are updated
in place; the ROADMAP reconciliation is delivered as a branch + PR for human
review (never committed directly to the default branch). Re-running sweep is
idempotent — already-specced issues are recognized as sufficient and skipped.

`backfill` is a safe maintenance flow for adding OpenSpec coverage to repositories
whose accepted behavior predates OpenSpec adoption. It classifies legacy behaviors
into four groups and optionally opens a spec-only PR for the missing-coverage slice:

```bash
/pipeline backfill                        # preview: four-group coverage report (no writes)
/pipeline backfill --apply                # apply: open a spec-only PR for missing behaviors
/pipeline backfill --apply --capability auth  # scope the slice to a named capability
```

Default is non-mutating preview. With `--apply`: authors an OpenSpec change with
additive requirement deltas, validates with `openspec validate`, and opens a
spec-only PR. Never commits directly to the default branch; never merges.
The diff is asserted to touch only paths under `openspec/` before the PR is created.
Re-running after a slice lands is idempotent — applied requirements are recognized
as already-covered and not duplicated.

`evals` is a manifest-driven **experiment runner**, not a gate: it replays
identical frozen fixtures through a matrix of harness/provider/model/effort
treatments so an observed difference is attributable to the treatment, not to
a changed issue, base commit, prompt version, or repository state. It is
unrelated to the `eval-gate` stage (a pass/fail check on a real PR) — `evals`
never touches `stages/eval.ts` and never participates in the label-driven
state machine:

```bash
/pipeline evals plan experiment.json      # expand + persist the run plan only
/pipeline evals run experiment.json       # execute every cell; resumable
/pipeline evals run experiment.json --fixtures core/evals/fixtures
```

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

`plan` expands the Cartesian fixture × treatment × replicate matrix
deterministically and writes `plan.json` **before** touching a harness or
creating a worktree — the same manifest and seed always produce the same
plan. `run` additionally executes every cell that has no completed record
yet, in seed-derived order interleaved across harnesses, each in a **fresh
worktree checked out at the fixture's `base_commit`** (never the current
branch head) — no two cells, including replicates, share a worktree, branch,
or session. **Evaluation mode performs zero production GitHub writes**: no
label, comment, PR, or push. Local-CLI cells enforce that at the **process
boundary** (PATH deny shim for `gh`/`git push|commit|worktree`/`pipeline`) and
by **stripping write credentials** from the harness child env — not by injecting
a TypeScript `EvalGhSurface` into the child. In-process evaluator code that
accepts a `gh` dependency still uses a refuse-and-record surface. Isolation is a
**cooperative-agent validity fence** for measurement correctness, not multi-tenant
OS security (absolute-path escapes / UID sandbox: deferred). Before treatments,
`evals run` runs **fixture integrity preflight** (reachable `base_commit`, path
tokens, baseline/biting probes) and classifies failures as infrastructure.
Empty-`grader_refs` fixtures must set `smoke_only: true` and never enter graded
quality aggregates. Interrupting and re-running `evals run` never re-executes a
completed cell or rewrites an existing `runs.jsonl`/`failures.jsonl` line.

**Multi-change maintainability fixtures (#577):** fixtures with
`kind: "multi_change"` declare ordered `checkpoints[]` (each with disclosed
`task_input` + held-out verifiers). A multi-change cell keeps one worktree
lineage across checkpoints while starting a **fresh model session** each step;
only declared pipeline evidence is preserved (no chat, no held-out verifier
bodies). At checkpoint *k* the runner runs new + inherited (1..k−1) held-out
verifiers; **strict pass** requires both green. Quality non-strict failures
continue the lineage; infra/auth/timeout abort as non-quality. Treatments may
set a `profile` axis (`bare` / `just-solve` vs `pipeline-current`; optional
`adversarial-review` / `quality-feedback` / `design-dossier`) without changing
prompts or verifiers — `#575` does not gate bare-vs-pipeline. Sample:
`core/evals/experiments/multi-change-bare-vs-pipeline.sample.json`. Grade with
`grader: "multi-change"`; report emits a `multi_change` section with separate
defect-state, effort, growth, and structural-telemetry dimensions — never a
synthetic maintainability/slop score.

Results land under `<output_dir>/<experiment-id>/`: `manifest.json` (the
resolved manifest as executed), `plan.json`, `runs.jsonl` (append-only,
`completed` cells only), and `failures.jsonl` (append-only, `infra_error` /
`auth_error` / `timeout` cells — infrastructure and auth failures are never
counted as a treatment outcome). Every record carries `experiment_id`,
`fixture_id`, `treatment_id`, `replicate`, `prompt_hash`, `config_hash`,
`base_sha`, and `env_surface_hash` (the fixture's environment-and-surface
provenance hash, #535) so a cell can be joined to ordinary run evidence.

Out of scope for this command: installing or authenticating provider CLIs,
and choosing a production model/effort policy from the results — those are
separate, tracked work. Grading and comparative reporting over a completed
experiment are covered next.

### Objective grading and comparative reporting

`evals grade` / `evals report` turn a completed experiment's cells into
objective grades and an uncertainty-aware comparison. Like `evals` itself,
**grades and summaries never gate a PR and never participate in the
label-driven state machine** — they are read-only analysis over an
experiment directory:

```bash
/pipeline evals grade experiment.json/exp1                       # writes grades.jsonl
/pipeline evals grade experiment.json/exp1 --judge                # + optional model judge (see below)
/pipeline evals report experiment.json/exp1 --baseline "harness=claude"  # writes summary.json
```

(The `<experiment-dir>` argument is `<output_dir>/<experiment_id>`, the same
directory `evals run` wrote `manifest.json`/`runs.jsonl` into.)

**Fixture contract extensions** (all optional; a fixture declaring none of
them still validates): `hidden_checks` (checks resolved only by the grader —
never exposed to the treatment; rejected if the same check also appears in
`public_checks`), `seeded_defects` (ground truth for review grading — a
`defect_id`, a `path` + line range, and an `expected_severity`),
`acceptance_criteria` (an `id` + `statement`, plus optional `check_names` for
implementation/fix grading or `keywords` for planning-rubric coverage),
`allowed_change_paths` (the boundary a correct implementation/fix result may
touch — absent means out-of-scope-change is reported `null`, never `0`), and
`grader_refs` (now `{grader, version}` objects, e.g.
`{"grader": "review", "version": "1"}` — an unsupported grader/version pair
fails fixture validation).

**Grading** (`evals grade`) reads `manifest.json`/`runs.jsonl` and the
fixtures, and writes `grades.jsonl` (one JSON record per graded cell) fresh
each run — `manifest.json`, `plan.json`, `runs.jsonl`, and `failures.jsonl`
are never modified, and regrading the same records twice is byte-identical.
Only `completed` cells whose fixture declares a `grader_ref` for the mode's
grader are graded; everything else is reported in a `skipped` list, never
silently dropped. `infra_error`/`auth_error`/`timeout` cells never receive a
substitute or zero score. Three deterministic graders, each versioned:

- **`implementation-fix` (v1)**: hidden-test pass rate, per-criterion
  acceptance completion, a regression count (a check that passed at the
  fixture's `base_commit` and fails on the candidate — the base-commit
  baseline is established once per fixture in a scratch worktree and
  memoized), a pre-existing-failure count (fails at both), and an
  out-of-scope-change count against `allowed_change_paths`.
- **`review` (v1)**: deterministic path + line-range matching of reported
  findings against `seeded_defects` — precision, recall, F1, a
  false-positive count, and a signed severity-calibration distribution
  (over- and under-calls are never averaged away). No model call in the
  match.
- **`planning` (v1, `planning-rubric-v1`)**: requirement coverage (keyword
  match against the plan's own output text), an unsupported-assumption
  count, an actionability score, and a downstream-compatibility score. A
  treatment's self-assessment, if any, is recorded as a separate
  observation and is never read as a grade input — the same plan text
  grades identically with or without one.

**Optional model judging** (`--judge`, disabled by default) writes its own
records (`judge_harness`/`judge_model`/`judge_prompt_version`/verdict) and
flags disagreements with the deterministic grade — it never moves a
deterministic grade field; every deterministic field is identical whether or
not judging ran. A judge/deterministic disagreement can be attached to a
**blinded human adjudication record**: the material shown to the adjudicator
identifies the cell only by an opaque key derived from `cell_id` (never
harness/provider/model/effort), and the record joins back to its cell by
that key at aggregation time.

**Comparative reporting** (`evals report --baseline <treatment_id>`) writes
a versioned `summary.json`: paired per-fixture quality deltas against the
named baseline (a fixture only contributes when both treatments have a
completed, graded cell for it; replicates are reduced to one value per
fixture before pairing so more replicates never means more weight; unpaired
fixtures are named, not dropped), completion and per-failure-class rates,
quality-versus-duration and quality-versus-cost Pareto frontiers (no combined
weighted score), and grouping by stage/harness/provider/model/effort/
category/risk with an explicit `unknown` bucket. Every aggregate effect
carries a confidence interval, its sample size, and the (seeded,
reproducible) interval method; an effect below the sufficiency threshold is
marked `underpowered` rather than hidden or overstated. A cell with no cost
telemetry is excluded from cost aggregates and counted toward a reported
coverage fraction — never imputed as zero.

`core/evals/fixtures/*.json` includes a small checked-in synthetic set
exercising every grader (`fix-graded-null-guard.json`,
`review-graded-seeded-defects.json`, `planning-graded-requirements.json`);
the grading/reporting test suite runs entirely against checked-in synthetic
fixtures and recorded cell records — no live model call, network request,
real git operation, or subprocess spawn.

### Treatment trajectory and verifier evidence artifacts (#536)

Diagnostic evidence for one cell — **never** a gating input — is available in
two kinds of immutable, content-addressed artifacts, referenced by descriptor
(`{path, content_hash, schema_version, byte_count, truncation_status}`) from
the compact streams rather than embedded inline:

- **Treatment trajectory artifact** (`evals run`, one per executed cell,
  referenced by `runs.jsonl`/`failures.jsonl` as `trajectory_artifact`):
  bounded per-stage output/error text, timing, success, produced-artifact
  paths, and a capability-aware `tool_events` channel — marked `unavailable`
  with a reason for every harness/executor this engine currently drives
  (none exposes structured tool-call telemetry yet), never faked as an empty
  successful channel. Raw provider chain-of-thought is neither requested nor
  required.
- **Verifier evidence artifact** (`evals grade`, one per deterministic
  grader; the optional judge emits its own, separately — referenced as
  `verifier_artifact` on the grade/judge/disagreement record): the
  verifier's inputs, the checks/evidence it consulted (this is where hidden
  checks, seeded-defect ground truth, and golden answers are permitted to
  live — they never appear in a treatment trajectory artifact or on a
  treatment-visible path), its identity/version, and its final result.

Both kinds are sanitized (the same secret-redaction/injection-denylist pass
as other run artifacts) and bounded (deterministic head/tail retention against
configurable byte/event ceilings, overridable via `--trajectory-max-events`/
`--trajectory-max-bytes` on `evals run`/`evals grade`) before being
content-addressed and written; a write failure is logged and never fails the
cell/grade. Artifacts are immutable — a resumed run or a regrade never
rewrites one; identical content dedupes to the existing file, and a
differing-content collision at the same address is surfaced rather than
silently overwritten. `pipeline evals report --link-artifacts` (opt-in;
default output byte-identical) additionally attaches these references for
flagged cells — outliers, judge disagreements, review false positives/
negatives, and failed cells — as a `linked_artifacts` field, without changing
any aggregate.

### Trace-to-fixture harvesting (`evals harvest`, #535)

`evals harvest` closes the authoring gap between recurring evidence and the
fixture contract above: it turns sanitized evidence into a **reviewable eval
fixture draft**, and stops there until a maintainer explicitly promotes it.
It is a human-approved authoring workflow, not an autonomous test-writer — it
never queues, advances, overrides, merges, or deploys anything, and makes no
GitHub call of any kind (`harvest.ts` calls no `gh.ts` function).

```bash
/pipeline evals harvest request.json                  # draft-only (default): prints the rendered draft
/pipeline evals harvest request.json --out draft.json # write the draft to a file instead of stdout
/pipeline evals harvest request.json --apply           # promote: loader-validate + write into --fixtures
/pipeline evals harvest request.json --apply --plan-only  # also prove the draft is executable (no live model, no GitHub write)
```

A **harvest request** (JSON) supplies one or more sanitized `evidence`
entries — a normal run-artifact excerpt, a `pipeline improve` cluster, or a
`correction_event`/control proposal (#499/#500) — plus the fixture material
(`base_commit`, `stage_entry_artifacts`, `grader_refs`, `category`, `risk`,
optional `environment` dependencies). The workflow resolves a
**capability-surface inventory** (stage, materialized prompts, harness/model
config, tools/hooks, repo paths, services/data), proposes **exactly one**
bounded ability or failure mode (refusing to batch evidence spanning more
than one), and records why an eval — rather than a lower/higher control
rung — is the right control level. Every evidence excerpt is routed through
the existing secret-redaction/injection-denylist pipeline before it can
reach a draft.

The fixture contract's `environment` field declares each external
tool/service/data dependency with a `live | simulated | forbidden` mode: the
default is `simulated`/`forbidden`, never `live` — setting `live` requires
an explicit maintainer selection, and rendering refuses a draft that would
otherwise silently default to it. The resolved `environment` +
capability-surface inventory are hashed into an `env_surface_hash` exposed
off the fixture and carried onto every cell record derived from it, so an
environment or agent-surface drift is visible as a hash difference between
experiment populations, alongside `prompt_hash`/`config_hash`/`base_sha`.

A maintainer can iteratively revise the proposed ability, task, dependency
modes, checks, or grader before promoting — each revision re-renders a
consistent, loadable draft. Promotion always re-validates with the same
fixture loader a hand-authored fixture goes through (an invalid draft is
rejected naming the offending field) and, with `--plan-only`, additionally
expands the promoted fixture into an executable cell plan to prove it works
— reusing the pure, no-harness `plan` expansion above.

## Setup (zero install after first run)

The skill is a Node 24+ TypeScript codebase under
`~/.claude/skills/pipeline/core/scripts/`, run via native type-stripping (no
build step). First-ever invocation runs `npm install` automatically.

Required:
- `gh` CLI authenticated against the target repo
- `claude` CLI on PATH — the primary harness (planning, implementation, fixes)
- `codex` CLI on PATH and authenticated — the reviewer harness (`prompt-harness` mode
  invokes it directly with a JSON-returning prompt, so **no review plugin is required**)
- Node 24+
- The user's Claude Code subscription provides the LLM budget — this skill
  never reads `ANTHROPIC_API_KEY`

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
# models.review: auto prefers claude-fable-5 for a Claude reviewer (adversarial rigor).
# On a Claude subscription without Fable usage credits, the engine performs one
# allowlisted in-process retry with sonnet when the preferred auto model returns
# the Fable/usage-credit entitlement 429. Explicit non-auto models are never
# silently rewritten. Claude CLI --fallback-model is not used for this recovery.
conventions_md_path: CLAUDE.md   # excerpt embedded in prompts
domain_name: lyric-utils
domain_description: a quantitative finance Python library
```

If absent, defaults from `core/scripts/types.ts:DEFAULT_CONFIG` apply. By default the pipeline is harness-relative: the invoking host's profile supplies both roles (Claude Code primary + Codex secondary under the `claude` profile, and the reverse under `codex`). A repository can pin its own primary (implementer) and secondary (reviewer) harness pair, overriding the profile, via the optional `harnesses:` block:

```yaml
harnesses:
  implementer: grok   # primary: planning, implementation, fixes, pre-merge repair, intake, sweep
  reviewer: codex      # secondary: plan review, review rounds, pre-merge delta review, shipcheck, design gate
```

Either key may be omitted — an omitted role keeps the active profile's default for that role only. `implementer` must name a harness with a registered adapter that declares the **implementer** role capability (built-ins: `claude`, `codex`, `grok`, `opencode`, `pi`, plus any IDs from `adapter_extensions` below). An unregistered implementer name is rejected at config-parse time, naming the key, the value, and the **currently registered** adapter IDs from the runtime registry, before any worktree is created. `reviewer` may name a registered adapter that declares the **reviewer** role, or an arbitrary custom reviewer CLI (compatibility path), same as the older `review_harness` key below.

### Outer-host lifecycle contract (#784)

The **outer host** is the session host that launches and supervises the pipeline
(install path, skill/command surface, durable handoff, event follow, reattach,
material notify, terminal cleanup/summary). It is **independent** of stage
adapter ID, provider/auth class, model, effort, and implementer/reviewer role
assignment. Built-in and third-party outer hosts register through the same
public registry (`core/scripts/outer-hosts/`) using co-located
`hosts/<id>/outer-host.manifest.json` files. Shared advance/loop orchestration
consumes declared capabilities and never branches on host name strings for
lifecycle behavior. Every capability has an explicit unsupported/fallback path;
the portable baseline is stdout JSON + `events.jsonl`. Install/update/uninstall
read managed paths from the install profile and preserve user-owned content.
A shared conformance kit gates complete declarations. See also identity
separation under adapter extensions below.

### Third-party adapter extensions (#783)

Register additional local-CLI adapters without editing engine source via `adapter_extensions` — a list of module entry points (repo-relative path, absolute path, or package name). **Only listed entries load**; unconfigured packages are never auto-scanned from `node_modules`.

```yaml
adapter_extensions:
  - ./tools/my-pipeline-adapter.cjs   # CommonJS module (createRequire-compatible)
```

Each module may:

1. `module.exports = { adapters: [harnessAdapter, ...] }` (or `export default` / `export const adapters` in a CJS-interop package)
2. `module.exports.register = (api) => { api.registerAdapter(adapter); }`

Adapters declare role capabilities (`implementer` and/or `reviewer`), executable resolution, prompt delivery/`maxPromptBytes` limits, model/effort/sandbox policy, telemetry, auth/version probes, and a cheap `runtimeSmoke` hook. Built-ins re-register through the same public contract. A shared conformance kit (CI) verifies declarations and refusal behavior.

**Identity separation:** outer host / profile (the CLI that launched the pipeline) stays independent of stage **adapter** ID, provider/auth class, model, and effort. Unknown provider/model metadata stays `unknown` / null — core never invents a vendor-global model catalog or silent default for extension adapters.

**Production treatment fingerprint & telemetry coverage (#778):** every local-CLI harness invocation that records stage accounting attaches a provider-neutral treatment fingerprint (adapter id/contract, CLI path/version from a once-per-run probe, capability hash, role when known, requested vs resolved model/effort, sandbox/tool policy, prompt/output contract stamps, fallback/throttle only when reported). Machine-readable telemetry is fixture-verified before an adapter declares it: `claude`/`codex`/`grok` recover cost and/or usage (and model/throttle when the envelope has them); `pi`/`opencode` stay `telemetry: none` until fixtures land. Unreported cost stays `cost_source: "unknown"` with `cost_usd: null` — never zero-filled. `PIPELINE_HARNESS_TELEMETRY=off` restores plain-text argv for adapters that support a kill-switch. When the probed CLI version diverges from an adapter's verified-against identity, the engine emits a fail-soft stderr warning and continues (version drift alone never blocks a stage).

**Custom reviewer migration:** unregistered `review_harness` / `harnesses.reviewer` names still work via a thin **compatibility adapter** on the extension contract (PATH preflight, treatment identity marked `origin: compatibility`). A full package registration for the same ID wins over compatibility.

The reviewer role MAY also be set (or overridden) via the optional `review_harness` key:

```yaml
review_harness: my-reviewer   # use a custom CLI as the reviewer instead of the profile default
```

When `review_harness` is set, the pipeline invokes that command through the compatibility adapter (default `<value> "<prompt>"` on argv, or stdin when `prompt_delivery: stdin`) and expects a JSON verdict on stdout (same schema as the built-in reviewers). If the CLI cannot be spawned, the item is blocked with an error naming the CLI explicitly, and the implementing harness is tried as a self-review fallback (established by #39). When both `harnesses.reviewer` and `review_harness` are set, they must agree — naming the same command is accepted (and `review_harness`'s structured model/effort/prompt-delivery settings still apply); naming different commands is rejected at config-parse time, naming both keys and both values.

`review_harness` also accepts a structured form for independent reviewer model/effort control, each accepting `"auto"` (resolved round-aware — plan-review/review-2 as Definitive, review-1 as Iterative):

```yaml
review_harness:
  command: claude
  model: auto
  effort: auto
```

### External stage executors (#314)

Beyond `review_harness` (which only overrides the reviewer CLI), any model-invoking
stage — `planning`, `implementing`, `review-1`, `review-2`, `fix-1`, `fix-2`,
`plan-review`, and `shipcheck-gate` when enabled — can be delegated to an **external
agent system** (OpenCode, HermesAgent, OpenClaw, or any other API-driven execution
backend) or, for review-only stages, to a raw **model endpoint** (e.g. a local Ollama
server). This is entirely opt-in: a repo with no `executors:`/`stage_executors:`
block behaves exactly as today.

```yaml
executors:
  opencode-main:
    type: agent-system              # full execution backend — valid for ANY model-invoking stage
    provider: opencode               # provider identifier (a plain string; not a built-in adapter)
    endpoint: https://opencode.internal/api
    credential: OPENCODE_API_KEY     # env-var NAME resolved at invocation time — never a literal value
  local-ollama:
    type: model-endpoint             # raw OpenAI-compatible chat/completions endpoint
    base_url: http://localhost:11434/v1
    model: llama3.1:70b
    # no credential needed for a localhost endpoint

stage_executors:
  planning: opencode-main
  review-1: local-ollama
  review-2: local-ollama
```

Key rules:

- **`agent-system`** executors may be assigned to any model-invoking stage. The
  pipeline `POST`s `{ stage, prompt }` to `endpoint` (with an `authorization: Bearer
  <credential>` header when `credential` is set) and expects `{ "output": "<text>" }`
  back; that text flows through the exact same downstream parsing (including
  `parseStructuredVerdict` for review stages) as a local CLI's stdout.
- **`model-endpoint`** executors are valid **only** for the prompt-contained stages
  `plan-review`, `review-1`, `review-2` — a raw endpoint has no repo/tool access, and
  these are the only stages whose prompt already carries all the context needed
  (diff, plan text, conventions excerpt) inline. Assigning one to `planning`,
  `implementing`, `fix-1`, `fix-2`, or `shipcheck-gate` is rejected **at
  config-parse time**, naming both the offending stage and executor — never
  discovered mid-run.
- Credentials are **references** (an env-var name), resolved from the environment
  only at invocation time; the value is never written to `pipeline.yml` or emitted
  in run evidence.
- A misconfigured, unreachable, or non-compliant executor **blocks the item** with
  an error naming the stage and provider — there is no silent fallback to the local
  `claude`/`codex` harness (this is distinct from, and takes priority over, the
  `review_harness` self-review fallback above, which never applies to a
  `stage_executors` assignment).
- Run evidence records which executor (and, for `model-endpoint`, which model)
  ran each delegated stage.

`model-endpoint` also accepts request controls for experiment treatments — an
explicit `dialect` (`openai` default | `openrouter` | `none`, never inferred from
`base_url`/`model`), an allowlisted `params` block, `headers` by literal or `env:`
reference, a `reasoning` effort request, and a `structured_output` hint (transport
only — `parseStructuredVerdict` + `review_policy` stay authoritative):

```yaml
executors:
  openrouter-review:
    type: model-endpoint
    base_url: https://openrouter.ai/api/v1
    model: openai/gpt-5
    credential: OPENROUTER_API_KEY
    dialect: openrouter
    params:
      temperature: 0
      provider: { order: [openai] }   # OpenRouter-only routing — rejected at parse time on any other dialect
    headers:
      http-referer: { env: OPENROUTER_REFERER }
    reasoning:
      effort: high
    structured_output: true

stage_executors:
  review-2: openrouter-review
```

Response evidence records resolved model, upstream provider, request id, finish
reason, usage, cost, and retry/rate-limit signals when the endpoint exposes them —
`null` when it doesn't, never guessed from the model string — and every
`model-endpoint` invocation's accounting record carries an explicit `api-key`
execution class, distinct from a local `claude`/`codex` harness invocation. See
`README.md`'s "External stage executors" section for the full request-control
reference.
## Conventions & carry-forward lessons

`readConventions` reads the target repo's conventions file (`conventions_md_path`, else `CLAUDE.md` on this host) and injects an excerpt into **every** stage prompt — planning, plan-review, plan-revision, implementing, both review rounds, and both fix rounds — via the `{{conventions}}` placeholder. This makes the conventions file the natural home for **carry-forward lessons**: a maintainer-curated `## Lessons / Gotchas` section (or a dedicated lessons file pointed at by `conventions_md_path`) recording recurring findings and repo-specific hazards. It is ordinary conventions text, so it rides the existing injection with **no extra config key, store, or flag** beyond the `conventions_md_path` / `CLAUDE.md` default.

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

Each iteration may block for up to ~20 minutes (heavy stages run
implementer/reviewer harnesses against the full repo). Worst-case full
path is 9 transitions, ~2 hours.

### 4. Orchestration pattern (host-side, for default-mode advance)

A foreground bash invocation will be killed at the harness's 10-minute
timeout — long before a planning stage finishes (~20 min cap each).
For the default advance mode, the harness **must** orchestrate the run as
follows.

#### Host notify map (material progress)

On each **material** progress line (shared material filter — see §4.c),
**must notify via the host map** below. Do not invent a pipeline push
service; do not gate stages on delivery. `events.jsonl` remains the
complete evidence stream.

**Outer-host lifecycle contract (#784):** material-progress notify, handoff,
event follow, reattach after cancelled wait, terminal cleanup, and terminal
summary are declared on the active outer host's `outer-host.manifest.json`
(capability `material_progress_notify` and peers). Shared orchestration
selects steps from those declarations — not from host-name equality checks.
Portable baseline is always stdout JSON + `events.jsonl` follow. Set
`PIPELINE_OUTER_HOST=<id>` so run evidence records outer-host identity
separately from implementer/reviewer adapter treatment.

| Host (declared mapping) | Follow / surface | Material path |
| --- | --- | --- |
| **Claude** (`claude_monitor_push`) | Monitor on material-filtered events; call `PushNotification` on each material one-liner | This file's §4.c–d |
| **Grok** (`grok_monitor_lines`) | Host `monitor` on the same material-filtered command (each stdout line = chat bubble). **Never** require Claude `PushNotification` | **Grok substitute** below |
| **Codex** (`codex_chat_status`) | Poll/follow material stream; concise chat/status updates (no Claude-only tools) | `hosts/codex/SKILL.md` |

**Grok substitute** (when this Claude overlay is the installed/symlink path Grok
loads — first-class `--host grok` is #731): use host **`monitor`** (or
equivalent) on the material-filtered event stream. Do **not** call
`PushNotification` on Grok; it does not exist there. Dual-follow still
applies after linkage (§4b.d) with the material filter on **both** streams.
Re-arm material follow after wait cancel until `loop_run_complete` / `loop_run_stopped`
(full re-attach semantics: #725). Dual-follow density demotion remains #611.

#### a. Status pre-check (fast, synchronous)

```bash
node ~/.claude/skills/pipeline/scripts/pipeline.mjs <N> --status
```

Confirms the target exists and has a `pipeline:*` label. A `blocked` label is
**not** a reason to stop: it is input to the durable recovery controller. Stop
only for an invalid target or a genuinely terminal issue state.

#### b. Launch the durable one-item controller

```bash
cd <repo_dir>
node ~/.claude/skills/pipeline/scripts/pipeline.mjs single <N>
```

Start it with Claude's background Bash runner and retain its process/task id.
Do not use `pipeline run <N> --detach` for the default `/pipeline N` path: that
command drives the raw advance state machine and bypasses durable recovery.
`pipeline single` prints an early `loop_run_handoff` JSON line after it owns the
durable lock and before the first child dispatch. Read `run_id` and `events`
from that line, then keep the controller process supervised until it exits.

#### c. Stream durable loop events

After the handoff, arm a persistent Monitor / host follow on the loop stream:

```bash
# Preferred: material one-liners for Claude Monitor / Grok monitor
node ~/.claude/skills/pipeline/scripts/pipeline.mjs loop logs <run-id> --events --follow \
  | node ~/.claude/skills/pipeline/scripts/material-filter.mjs

# Diagnostic fallback: full loop events.jsonl
node ~/.claude/skills/pipeline/scripts/pipeline.mjs loop logs <run-id> --events --follow
# default until-terminal: exits 0 after loop_run_complete or loop_run_stopped
```

Per-advance details remain linked by `loop_item_advance_linked`; use its
`pipeline_run_id` with `pipeline logs <advance-run-id> --events --follow` only
for diagnostics. Set `persistent: true`, `timeout_ms: 3600000`, and re-arm a
cancelled follow until a terminal loop event appears. After terminal evidence,
wait for the retained `pipeline single` process and read its final JSON result.

#### d. Notify via host map on material event records

Notify via the host map for every material loop line: item
start/transition/block, advance linkage/completion, stage/gate progress,
recovery attempts, and `loop_run_complete` / `loop_run_stopped`. The shared
filter suppresses repeated CI waiting, OpenSpec skipped events, heartbeats, and
accounting noise. On Claude, call `PushNotification`; on Grok, the host monitor
surfaces each line; on Codex, use concise chat/status updates.

Linked advance diagnostics use the same shared material set: `run_start`,
`stage_start`, `stage_complete`, `pr_created`, `pr_updated`, `review_verdict`,
`gate_result`, `blocker_set`, `blocker_cleared`, and `run_complete`.

#### e. Re-attach after cancelled or lost follow

A cancelled Monitor, wait timeout, or session pause is not a terminal pipeline
outcome and must not be treated as "stop watching." Re-arm in the same harness
turn after checking the retained controller process and loop stream. If the
process is live or neither terminal kind is present, run:

```bash
node ~/.claude/skills/pipeline/scripts/pipeline.mjs loop logs <run-id> --events --follow
```

Supervision ends only after `loop_run_complete` / `loop_run_stopped` and the
controller process exits. Do not leave the controller or a follow running when
the harness turn ends.

#### f. Final summary

Surface the final JSON printed by `pipeline single`; optionally add the
read-only durable audit:

```bash
node ~/.claude/skills/pipeline/scripts/pipeline.mjs loop --resume <run-id> --audit
```

Include recovery actions attempted, final item state, linked advance/PR
evidence, and the merge-next-step note that the pipeline does not auto-merge.
Send one final host notification with the terminal state.


### 4b. Orchestration pattern for `/pipeline:loop` (multi-item durable drive/resume)

Multi-item drive and resume via `/pipeline:loop` is **long-running** (minutes to
hours). It is **not** a seconds-only synchronous command. Do **not** treat it as
Monitor-free fire-and-forget — follow the same spirit as single-issue advance
(§4), using the loop event stream.

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
node ~/.claude/skills/pipeline/scripts/pipeline.mjs loop --milestone <name> \
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
// field 22 overall = index 19 after pid+comm removed (man 5 proc)
if(!f[19])process.exit(1); process.stdout.write(f[19]);' "$pid" 2>/dev/null) && [ -n "$out" ] && { printf '%s' "$out"; return 0; }
  fi
  # Darwin / portable fallback — do not require /proc
  out=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -n "$out" ] && printf '%s' "$out"
}
LOOP_START=$(process_starttime "$LOOP_PID") || { echo "failed to capture launcher starttime"; wait "$LOOP_PID"; exit 1; }
```

On a preflight failure the process exits quickly with printed remediation on
stderr — do not start any substitute loop. If `$LOOP_PID` exits (or its
starttime changes — PID reuse) before a run directory is mapped, read
`$LOOP_ERR` and stop.

#### b. Obtain `run_id` + loop events path (before completion)

**Order of preference:**

1. **Early handoff** when present (stdout/JSON carrying at least `run_id` and a
   loop events path — #665). Prefer this over filesystem discovery.
2. **`--resume <run-id>`** (or an operator-known id): use that `run_id`
   immediately; arm the Monitor before or right after launching.
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
    # Launcher instance still this launch AND lock is that process or descendant.
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

Arm a follow on the loop events file **as soon as** `run_id` is known (step b)
— do not wait for supervisor exit. Prefer the first-class CLI (exits 0 on
`loop_run_stopped` or `loop_run_complete` by default) **piped through the shared material filter**
for host notify (raw unfiltered events remain available for diagnostics):

```bash
# Preferred — material one-liners for host notify (dual-follow uses the same filter)
node ~/.claude/skills/pipeline/scripts/pipeline.mjs loop logs <run_id> --events --follow \
  | node ~/.claude/skills/pipeline/scripts/material-filter.mjs
# default until-terminal: process exits 0 after loop_run_stopped/loop_run_complete
# interrupt-only dashboards: add --no-until-terminal

# Diagnostic fallback — full unfiltered loop events.jsonl
node ~/.claude/skills/pipeline/scripts/pipeline.mjs loop logs <run_id> --events --follow
```

If you arm a host Monitor / Grok `monitor` instead of (or around) that CLI, do
**not** leave it `persistent: true` past terminal — §4b.f requires same-turn
teardown. **Re-arm** material follow after wait cancel until `loop_run_stopped`
or `loop_run_complete`
(full re-attach: #725).

**Do not** use a bare `tail -F` on `events.jsonl` as a follow fallback: it never
exits after a terminal loop event, prints no final summary, and leaves zombie
follows. Prefer the CLI above. A raw dual-follow / multi-stream script is only
valid when it **explicitly tracks** its tail child PID, **TERM/KILL**s that child
before exit (process substitution + bare `exit 0` orphans `tail -F`), prints a
final summary line, and **`exit 0`** after either terminal loop event.

Never forbid Monitor or background following for drive/resume.

**Dual-follow / multi-stream pattern** (loop + optional advance): when the
script observes `loop_run_stopped` or `loop_run_complete` on the loop stream, print a final summary
line (include terminal reason when present), **terminate the tracked tail
child**, and **`exit 0`**. Do **not** print `TERMINAL` inside `while true` and
keep looping — that leaves zombie follows. Example terminal-aware raw fallback
(explicit child teardown; prefer the CLI):

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
    *'"kind":"loop_run_stopped"'*|*'"kind": "loop_run_stopped"'*|*'"kind":"loop_run_complete"'*|*'"kind": "loop_run_complete"'*)
      reason=$(printf '%s' "$line" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      echo "TERMINAL reason=${reason:-stopped}; follows stopped"
      stop_tail
      trap - EXIT INT TERM
      exit 0
      ;;
  esac
done <"$FIFO"
```

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

**Must** also arm material-filtered advance follow for mid-item stage progress
(dual-follow). Prefer material filter on **both** streams over dual raw
unfiltered JSONL:

```bash
node ~/.claude/skills/pipeline/scripts/pipeline.mjs logs <advance-run-id> --events --follow \
  | node ~/.claude/skills/pipeline/scripts/material-filter.mjs
```

The absolute `events` path from the linkage record is an acceptable alternative
target (e.g. Monitor / Grok `monitor` / `tail -F` on that file, still preferably
through the material filter).

**Before linkage exists:** continue loop-only follow — do **not** require a
non-existent advance-linkage field.

**Follow lifecycle:**

1. **Arm** advance follow when linkage publishes `pipeline_run_id` / `events`.
2. On a **new item's** advance linkage, **switch or add** follow for the new
   advance run; **stop** the prior item's advance follow on that item's terminal
   advance outcome (e.g. `run_complete`) rather than leaving stale follows open.
3. Keep the **loop** event stream follow active across item boundaries until a
   terminal loop outcome or supervisor process exit.

**Material advance kinds** to surface via the host map (same spirit as
single-issue §4; shared filter constant):

- `stage_start`
- `stage_complete`
- `pr_created`
- `review_verdict`
- `gate_result`
- `blocker_set`
- `run_complete`

**Suppress** pure CI poll spam — including repeated identical
`pre_merge.advancePolling`-style updates and repeated CI `partial` / OpenSpec
`skipped` spam in the same burst (surface the first material stage/gate event;
wait for the eventual advance/block outcome). The material filter enforces this
deterministically.

**Loop-only follow** remains valid for schedule, hold, and terminal **loop**
kinds (`loop_schedule_evaluated`, holds, `loop_run_stopped`, …), but is
**insufficient alone** for mid-item stage progress until #611 ships. When #611
makes the loop stream carry first-class stage progress, this dual-follow
mandate **MAY** be demoted to optional / “recommended for full fidelity” in
that same PR (with host skill + living-spec updates together). Do **not** demote
solely for quieter notifications while the loop stream is still sparse. This
notify packaging change (#742) does **not** replace #611 or #725.

#### e. Notify via host map on material loop events

**Must notify** via the host map (Claude: `PushNotification`; Grok: host
`monitor` material lines; Codex: chat/status — **not** a universal Claude-only
tool):

- `loop_item_started`
- `loop_item_transitioned`
- `loop_item_blocked`
- `loop_item_advance_linked` / `loop_item_advance_finished`
- `loop_item_stage_progress` (when present)
- `loop_run_stopped`
- `loop_run_complete`

**Should notify** when present (not spam; material filter applies):

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
`pre_merge.advancePolling` in §4). Do not re-notify every identical
`loop_item_progress` CI waiting poll after the first for a stretch.

#### f. Stop following (same turn — mandatory)

When a material **`loop_run_stopped`** event is observed for the followed
`run_id`, **or** when the supervisor process for that run exits: **in the same
harness turn**, stop **all** loop event Monitors/follows **and** all advance
event Monitors/follows started for that loop run (including dual-follow /
multi-stream tails). Do **not** leave those follows running until the operator
asks to kill them. Do **not** kill Monitors for other issues, other run ids, or
session tools unrelated to that loop `run_id` / its published advance run ids.

Documented dual-follow scripts **exit 0** after `loop_run_stopped` and a final
summary line — they must not continue an infinite follow loop after terminal.
Stop the loop Monitor when a terminal loop outcome appears — especially
`loop_run_stopped` — or when the supervisor process exits. Stop (or replace) the
active item's advance follow on that item's terminal advance outcome when
switching items or when the advance run completes; do not leave unbounded stale
advance follows open.

#### g. Final summary / audit

Surface the run's terminal state. Prefer the printed JSON result; for a
read-only process/timeline report:

```bash
node ~/.claude/skills/pipeline/scripts/pipeline.mjs loop --resume <run-id> --audit
# stage table + optional whole-run stage-progress follow (not harness stdout):
node ~/.claude/skills/pipeline/scripts/pipeline.mjs loop --resume <run-id> --audit --follow
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
- `doctor` — deterministic preflight by default (no model calls); opt-in `--harness-smoke` adds cheap runtime smoke, completes in seconds without the flag
- `/pipeline:loop --audit` — read-only report (stage table) for a durable run; synchronous, no Monitor
- `/pipeline:loop --resume <run-id> --audit --follow` — read-only stage-progress stream; no run-liveness lock

Run those synchronously, no Monitor, no background, no host-map notify (except
follow, which streams until interrupt).

**Not in this list:** multi-item `/pipeline:loop` drive or resume (with or without
`--milestone` / issue lists / `--resume`) — those use §4b long-running
orchestration. Do not apply the seconds-only / no-Monitor rule to drive/resume
just because `--audit` is fast.

`--once` still needs the orchestration because a single heavy stage
(planning especially) can hit its 20-min timeout. Use the same
background + material follow + host-map notify pattern as default mode; just
expect at most one transition before the run exits.

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

Do not create HTML for simple `/pipeline N --status`, `--dry-run`, or one-step summaries unless the user asks.

### 7. Final summary

When the loop ends, the skill prints:
- Starting stage → ending stage
- Number of transitions
- Wall-clock elapsed
- For terminal: PR URL + ready-to-deploy summary
- For blocked: latest blocker comment + the unblock command
- For waiting: short reason + "re-run /pipeline N when ready"

## Failure modes

- **`gh` not authenticated** → tell user `gh auth login`, exit.
- **No git repo at cwd / repo-path** → exit 2 with "run from inside a checkout".
- **Issue # doesn't exist** → surface `gh` error, exit 1.
- **PR has no linked issue** → refuse with the explanation.
- **No `pipeline:*` label** → refuse with opt-in instructions.
- **Stage handler error** → posts a `blocked` label + structured comment
  with reason; loop terminates and shows the latest blocker.
- **Primary harness fails (planning/implementation/fix)** → blocked unless the stage explicitly defines a safe fallback.

## What this skill never does

- Merge from the advance path — there is no `auto_merge` config key or merge stage. `/pipeline:merge <pr>` is a separate operator-authorized command after `pipeline:ready-to-deploy`; advance never calls it. `/pipeline:merge-queue --milestone <m>` is dry-run by default; only the separate `--apply` form can merge. External supervisors may call merge commands under operator authority; the repository does not ship a factory grant control plane.
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
- `core/scripts/harness.ts` — `invoke("claude" | "codex", cwd, prompt)` (planning/impl/fix)
- `core/scripts/stages/review.ts` — review-1/review-2 invoke the `codex` CLI directly
  with the pipeline's JSON-returning review prompt
- `core/scripts/lock.ts` — PID-based lock at `/tmp/pipeline-{domain}.lock`
- `core/scripts/stages/*.ts` — one file per stage (planning, review, fix, pre_merge, eval, deploy_ready, auto_recover)
- `core/scripts/prompts/*.md` — prompt templates with `{{placeholders}}`
- `core/scripts/pipeline.ts` — top-level orchestrator + CLI
- `README.md` — human-facing docs
