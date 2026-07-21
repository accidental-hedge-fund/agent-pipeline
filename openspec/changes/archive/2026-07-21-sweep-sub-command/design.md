## Context

The pipeline CLI already has two no-issue-number sub-commands that follow the same pattern (`release.ts`, `intake.ts`): a positional keyword is detected early in the dispatch block, a dedicated `stages/<name>.ts` handler is imported and called, and all external I/O is injected via a `<Name>Deps` interface. The `intake` sub-command (issue #158) already embeds the WHAT-not-HOW / observable-AC spec contract as a prompt template. The `sweep` sub-command follows the same structure, extended with a bulk-iteration loop and a roadmap-reconciliation phase that can reuse the ROADMAP anchor-based mutation helpers already present in `release.ts`.

## Goals / Non-Goals

**Goals:**
- Add `sweep` as a fully-exercised no-issue-number sub-command using the existing dispatch and injectable-deps patterns.
- Classify open issues into "sufficient" and "thin" without a model call; invoke the spec-generation harness only for thin issues.
- Preserve author context in generated specs — treat the original body as input to the spec-generator, not noise to be discarded.
- Reuse the ROADMAP anchor-based mutation helpers from `release.ts` for the roadmap-reconciliation phase.
- `--apply` is the only gate for writes; the default is a fully read-only preview.
- Re-running sweep is idempotent — already-specced issues are recognized by the sufficiency heuristic without a model call.

**Non-Goals:**
- Running planning or implementation — sweep is a backlog/roadmap maintenance pass only.
- Closing issues, changing labels beyond what already exists, or restructuring issues beyond filling out thin descriptions.
- Creating new issues from scratch — that's `intake`'s front door.
- Auto-merging the roadmap PR — a human owns the merge button.
- Interactive prompting — the command is non-interactive; all inputs are flags.

## Decisions

**Decision: embed the spec-generation prompt in `core/`, not a dependency on the `/pm` skill.**
The pipeline engine has zero external-skill dependencies today. The WHAT-not-HOW / observable-AC spec contract is a few dozen lines of prompt text, easily embedded in `core/scripts/prompts/sweep.md` with `{{placeholders}}` for the existing body, issue title, and repo context. This also lets `sweep` and `intake` share a common contract without coupling either to an externally-versioned skill.

**Decision: sufficiency is a structural heuristic, not a model call.**
A model call per issue to assess sufficiency would be expensive for large backlogs and would make re-runs non-idempotent on token cost alone. The sufficiency heuristic checks: (a) body length above a minimum threshold (e.g. ≥ 150 characters), (b) presence of at least two of the required section headings (Summary, User story, Acceptance criteria, Out of scope), and (c) absence of a single-sentence body. This heuristic is deterministic and fast; it is the only gate before deciding to invoke the model.

**Decision: one model call per thin issue, sequentially.**
Parallel model calls across many issues would complicate error handling, conflict with the host's rate limits, and make the dry-run report non-reproducible between consecutive runs. Sequential calls are predictable, easy to interrupt, and keep the implementation simple; the typical backlog size where this matters (< 50 issues) does not justify parallelism.

**Decision: roadmap reconciliation is separate from issue re-speccing and runs after.**
Re-speccing may change which issues exist or what they describe; the roadmap pass needs to see the final state of the issues (or the intended state in dry-run mode) before computing a coherent reconciliation. Running reconciliation after re-speccing also means a single sweep invocation leaves both the backlog and the roadmap consistent.

**Decision: `--apply` as the write gate, not `--dry-run` as a flag.**
The issue explicitly requests an `--apply`-to-write model. This is the same convention used by the `roadmap` sub-command (issue #171): omitting `--apply` is always safe, and an explicit opt-in is required before any GitHub write occurs. The implementation SHALL default to dry-run mode and print a clear notice when the user omits `--apply`.

**Decision: injectable deps seam covers all external calls.**
Following the `ReleaseDeps` / `IntakeDeps` pattern: `SweepDeps` injects `listIssues` (gh list), `getIssueBody` (gh read), `updateIssueBody` (gh write), `runHarness` (model call), `readFile`/`writeFile`, `gitCreateBranch`, `gitCommit`, `createPR`, `log`. Production builds `realSweepDeps()`. Tests supply fakes. No network or subprocess in unit tests.

**Decision: roadmap reconciliation reuses `release.ts` anchor helpers.**
`release.ts` exports anchor-based `ROADMAP.md` mutation helpers. The sweep reconciliation uses the same approach — reading, mutating in memory, writing on a branch, and opening a PR — rather than re-implementing anchor scanning. The key difference is that reconciliation may need to *update* existing rows (when an issue was already on the roadmap but its description has changed) in addition to adding new rows; a new `upsertPerIssueRow` helper covers this case.

## Risks / Trade-offs

- *Sufficiency heuristic false positives* → A structurally-compliant but thin body (e.g. correct headings, minimal content) passes the heuristic and is skipped. Mitigation: the heuristic is tunable via config (`sweep.min_body_length`, `sweep.required_sections`); the dry-run report shows the classification rationale so the user can inspect.
- *Spec quality depends on existing body quality* → A one-sentence body with no useful context produces a lower-quality spec. The dry-run mode lets the user inspect before committing, and the generated spec always preserves the original title and any existing body content as input to the generator.
- *Roadmap anchor drift* → If ROADMAP.md anchors are renamed, the mutation helpers throw with an "anchor not found" error. Same risk class as `release.ts` and `intake.ts`; the error message names the missing anchor.
- *Large backlogs and rate limits* → A repo with 200 thin issues would produce 200 sequential harness calls. Mitigation: the user can scope the sweep with `--since <date>` or `--label <label>` to restrict the issue set; the dry-run report shows the count before any writes.
