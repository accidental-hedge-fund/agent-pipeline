## Why

Pipeline Desk's **Refine spec** action is blocked: the only spec-refinement path in `agent-pipeline` is `pipeline intake`, which is a mutating workflow (creates GitHub issues, writes `ROADMAP.md`, opens PRs) and cannot safely be called from a preview/confirmation surface. The `--new` flag that previously served this role was removed. A dedicated non-mutating contract is needed so Pipeline Desk can show an operator a spec diff to review before any change is committed.

## What Changes

- Add `refine-spec` as a new no-issue-number sub-command accepted by the pipeline CLI.
- Add `core/scripts/stages/refine-spec.ts` implementing the handler with injectable deps (mirroring the `intake`/`release` pattern).
- The handler invokes a single model harness call that takes an existing issue's `--title` and `--body` and returns a refined spec — identical in structure to the `intake` spec contract: Summary, User story, Acceptance criteria, Out of scope, and Open questions when genuinely ambiguous.
- Output is written to stdout as a single unfenced JSON object with fields `title` (string), `body` (string), and `milestone` (string | null); all other side effects are prohibited.
- The sub-command performs **no GitHub writes**, **no git writes**, and **no filesystem writes** — the operation is strictly read → harness → stdout.
- Discoverability: `pipeline refine-spec --help` SHALL exit 0 with usage text, so a caller can probe for the contract before invoking it with real content.
- **BREAKING**: None. The sub-command is additive; existing commands are unaffected.

## Capabilities

### New Capabilities
- `refine-spec-preview`: The `refine-spec` no-issue-number sub-command: CLI dispatch, non-mutating spec-refinement harness call, and machine-readable JSON stdout contract.

### Modified Capabilities
- `pipeline-state-machine`: The CLI positional-argument dispatch block gains `refine-spec` as a recognized keyword that requires no issue number and advances no stage label; it MUST be listed in the help text alongside other no-issue-number modes.

## Impact

- `core/scripts/pipeline.ts` — dispatch block, help text, flag definitions (`--title`, `--body`); `--json` is already global.
- `core/scripts/stages/refine-spec.ts` — new file (sub-command handler + injectable deps interface).
- `core/scripts/prompts/refine-spec.md` — new prompt template for the spec-refinement harness call.
- `core/test/refine-spec.test.ts` — unit tests for the new stage.
- `plugin/` mirror — regenerated after any `core/` change.
- `README.md` / `hosts/claude/SKILL.md` — document the new sub-command.

## Acceptance Criteria

- [ ] `pipeline refine-spec --title "<t>" --body "<b>"` is accepted by the CLI and dispatched without requiring an issue number.
- [ ] The command makes exactly one model harness call and exits; no GitHub reads or writes occur.
- [ ] No branch is created, no commit is made, no push occurs, and `ROADMAP.md` is not written.
- [ ] Stdout is a single unfenced JSON object with at minimum: `title` (string), `body` (string), `milestone` (string | null).
- [ ] The `body` field follows the intake section contract: Summary, User story, Acceptance criteria, Out of scope, and Open questions only when there is genuine ambiguity.
- [ ] Running the command twice on the same input leaves all repo and GitHub state unchanged.
- [ ] `pipeline refine-spec --help` exits with code 0 and prints usage text, enabling caller probing.
- [ ] `pipeline refine-spec` with no title/body exits non-zero with a usage error (not an unhandled crash).
- [ ] All logic is covered by unit tests using injectable deps (no real network, git, or subprocess in tests).
- [ ] `npm run ci` passes end-to-end after the change.
