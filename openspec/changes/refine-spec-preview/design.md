## Context

`pipeline intake` is the only existing spec-generation path and is unsafe to reuse here: it creates a GitHub issue, writes `ROADMAP.md`, and opens a PR, making it impossible to retrofit a truly non-mutating mode without fundamentally changing its contract. Pipeline Desk needs a preview surface that carries zero risk of accidental mutation before an operator confirms.

The existing CLI already handles several no-issue-number sub-commands (`release`, `init`, `doctor`, `triage`, `sweep`, `merge`) with a consistent pattern: an early keyword check in the dispatch block, a dedicated `stages/<name>.ts` handler, and all external I/O injectable via a `<Name>Deps` interface. `refine-spec` follows this pattern exactly.

## Goals / Non-Goals

**Goals:**
- Provide a non-mutating, machine-readable spec-refinement command callable by Pipeline Desk before operator confirmation.
- Reuse the existing `intake` spec-generation prompt contract (same section structure: Summary, User story, Acceptance criteria, Out of scope, Open questions).
- Keep the model-invoking boundary to a single harness call so the behavior is auditable.
- Support probing for the command's presence via `--help`.

**Non-Goals:**
- Writing the refined spec back to the issue (a separate, operator-confirmed mutating flow).
- ROADMAP reconciliation (that remains `intake`/`sweep`/`roadmap` territory).
- Retrofitting `intake --preview-only` — reusing `intake`'s dispatch path risks accidentally wiring the mutating deps to a non-mutating call; a dedicated handler is safer and clearer.
- Interactive prompting — the command is non-interactive; inputs are flags only.
- Tuning spec quality beyond the existing `intake` harness contract.

## Decisions

**Decision: dedicated `refine-spec` sub-command, not `intake --preview-only`.**
Adding `--preview-only` to `intake` creates a boolean flag that suppresses most of `intake`'s side effects — a classic feature flag that makes the non-mutating path depend on the correctness of every future change to the mutating path. A dedicated handler (`refine-spec.ts`) has no GitHub/git deps in its `RefineSpecDeps` interface at all; there is nothing to accidentally enable. The separation also makes the invariant testable: the `RefineSpecDeps` interface physically cannot express a GitHub write, so no test stub is needed to prove writes don't happen.

**Decision: separate `--title` and `--body` flags, not a single combined `--description`.**
Pipeline Desk's Refine spec modal already holds the issue's title and body as discrete fields (mirroring the GitHub API). Accepting them separately eliminates the need for a client-side concatenation convention and lets the harness prompt template independently reference `{{title}}` and `{{body}}` — which may produce better refinements than a fused blob. The description-only form used by `intake` is appropriate for greenfield specs; title+body is appropriate for refining an existing issue.

**Decision: `milestone` field in the JSON output MAY be null; no release-slot inference.**
`intake` infers a release slot from `ROADMAP.md`; doing so here would require a filesystem read, adding a new dep and a potential read failure. Milestone assignment on refinement is a human decision that happens when the operator applies the refined spec. The `milestone` field is included in the output schema for forward-compatibility but SHALL default to `null` unless the harness explicitly derives one from the input body.

**Decision: `--help` as the discovery probe.**
Pipeline Desk needs to know whether the installed engine supports this contract before calling it. The binary already follows Commander.js conventions where each sub-command responds to `--help` with exit code 0. Documenting `pipeline refine-spec --help` as the probe is zero-cost (no new flags), follows existing conventions, and lets a client distinguish "command not found" (`unknown command` error, non-zero) from "command present" (help text, exit 0).

**Decision: injectable deps interface has no write-capable slots.**
`RefineSpecDeps` SHALL expose only: `runHarness` (model call), `log` (stderr progress). No `createIssue`, `writeFile`, `gitCreateBranch`, or `createPR`. The absence of these in the interface is the structural guarantee that no future diff can accidentally wire a write — unlike a `--preview-only` flag that suppresses writes at runtime.

## Risks / Trade-offs

- *Spec quality depends on input quality* → A minimal title and empty body produce a low-quality refinement. The command is still safe (no writes); quality is the caller's problem. The dry-run/preview nature of the feature means the operator evaluates the output before doing anything with it.
- *Harness call may time out or be refused* → The handler propagates the error with a non-zero exit and no partial output. The client should handle non-zero exits gracefully.
- *`--help` probe is CLI-framework-specific* → If the CLI framework changes, `--help` behavior could change. This is low risk; the Commander.js convention is stable across the codebase.
- *JSON output could include unexpected harness preamble* → If the harness returns markdown fences or prose before the JSON, `JSON.parse` fails. Mitigation: the prompt template SHALL explicitly request bare JSON with no surrounding text, mirroring the `--status --json` precedent from `machine-readable-status`.

## Open Questions

None — the open question from the issue (dedicated command vs. `intake --preview-only`; separate title/body vs. combined description) is resolved above. A dedicated `refine-spec` sub-command with separate `--title` and `--body` flags is the chosen approach.
