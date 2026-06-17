## Why

Intake is two manual steps today that drift apart: filing an under-specified issue (burning planning rounds clarifying it) and separately updating `ROADMAP.md` three times (release-plan row, per-issue sem-ver row, detail section). A single `pipeline intake` sub-command turns a one-line description into a decision-complete GitHub issue *and* a matching roadmap-update PR in one shot, keeping the backlog implementable and the roadmap the single source of truth without manual double-entry.

## What Changes

- Add `intake` as a new no-issue-number positional sub-command keyword (alongside `init`, `doctor`, `logs`, `path`, `config`, `run`, `release`) accepted by the pipeline CLI.
- Add `core/scripts/stages/intake.ts` implementing the sub-command handler with injectable I/O deps (same seam pattern as `release.ts`).
- The handler invokes a model-backed spec-generator (one harness call) that expands the caller's short description into a structured spec: Summary, User story, Acceptance criteria, Out of scope, and Open questions when genuinely ambiguous — following the same WHAT-not-HOW / observable-AC contract as the `/pm` skill.
- The handler deterministically creates a GitHub issue from the generated spec body, applying a `pipeline:ready` triage label and a `release:vX.Y.Z` label derived from the proposed release slot.
- The handler deterministically writes a `ROADMAP.md` update (release-plan table row, per-issue sem-ver table row, detail-section bullet) on a new branch and opens a PR for human review — never commits directly to the default branch. The roadmap edit reuses the existing anchor-based mutation helpers from `release.ts`.
- `--dry-run` prints the proposed spec and roadmap diff without any GitHub write.
- `--release <vX.Y.Z>` lets the caller pin the target release slot; omitting it makes the handler propose one with a rationale from the roadmap context.
- Add a `--description "<text>"` flag (or second positional after `intake`) to supply the free-text seed.

## Capabilities

### New Capabilities
- `intake-sub-command`: The `intake` no-issue-number sub-command: CLI dispatch, spec-generation harness, issue creation, and roadmap-PR proposal.

### Modified Capabilities
- `pipeline-state-machine`: The CLI positional-argument dispatch block gains `intake` as a recognized keyword that requires no issue number and advances no stage label; it MUST be listed in the help text alongside other no-issue-number modes.

## Impact

- `core/scripts/pipeline.ts` — dispatch block, help text, flag definitions (`--description`, `--release`).
- `core/scripts/stages/intake.ts` — new file (sub-command handler + injectable deps interface).
- `core/scripts/prompts/` — new prompt template for the spec-generation harness.
- `core/test/intake.test.ts` — unit tests for the new stage.
- `plugin/` mirror — regenerated after any `core/` change.
- `README.md` / `hosts/claude/SKILL.md` — document the new sub-command.

## Acceptance Criteria

- [ ] `pipeline intake --description "<text>"` (or `pipeline intake "<text>"`) is accepted by the CLI and dispatched without requiring an issue number.
- [ ] A single model harness call produces a structured spec (Summary, User story, Acceptance criteria, Out of scope) from the input description; Open questions appear only when the description is genuinely ambiguous.
- [ ] The spec follows the WHAT-not-HOW / observable-AC contract: acceptance criteria are testable behaviors, not approach descriptions.
- [ ] A GitHub issue is created with the generated spec body and at least two labels: a `pipeline:*` triage label and a `release:*` label.
- [ ] A `ROADMAP.md` update is committed on a new branch and a PR is opened targeting the default branch; no direct commit to main/default.
- [ ] The roadmap update writes all three structures consistently: release-plan table row, per-issue sem-ver table row, detail-section bullet.
- [ ] `--dry-run` prints the proposed issue body and roadmap diff and exits without writing to GitHub or the filesystem.
- [ ] `--release <vX.Y.Z>` pins the target release slot; omitting it produces a proposed slot with a rationale.
- [ ] The spec-generation step is the only model-invoking part; issue creation and roadmap editing are deterministic given the generated spec.
- [ ] All new logic is covered by unit tests using injectable deps (no real network, git, or subprocess in tests).
- [ ] `npm run ci` passes end-to-end after the change.
