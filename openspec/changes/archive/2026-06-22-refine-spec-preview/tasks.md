## 1. CLI dispatch wiring

- [x] 1.1 Add `refine-spec` to the recognized no-issue-number keyword detection in `pipeline.ts`; dispatch it before config resolution (mirroring the `release`/`intake` pattern).
- [x] 1.2 Add `--title "<text>"` and `--body "<markdown>"` options to the commander definition; ensure the global `--json` flag is threaded through.
- [x] 1.3 Update the `.argument(...)` description string and top-level help text to list `refine-spec` alongside peer sub-commands.
- [x] 1.4 Import `runRefineSpec` from `./stages/refine-spec.ts` and add the early dispatch call.

## 2. Spec-refinement prompt

- [x] 2.1 Author `core/scripts/prompts/refine-spec.md` with `{{title}}` and `{{body}}` placeholders, embedding the WHAT-not-HOW / observable-AC section contract (Summary, User story, Acceptance criteria, Out of scope, Open questions) and an explicit instruction to return bare JSON with no surrounding prose or code fences.
- [x] 2.2 Register the prompt in `core/scripts/prompts/index.ts` (or equivalent loader) so it is injectable via the existing template-render path.

## 3. `RefineSpecDeps` interface and `realRefineSpecDeps()`

- [x] 3.1 Define `RefineSpecDeps` in `refine-spec.ts`: `runHarness` (model call), `log` (stderr progress). No write-capable slots.
- [x] 3.2 Implement `realRefineSpecDeps()` wiring `runHarness` to the real harness invoker and `log` to stderr.

## 4. `runRefineSpec` handler

- [x] 4.1 Validate inputs: both `title` and `body` present; exit non-zero with a usage error if either is missing.
- [x] 4.2 Render the `refine-spec.md` prompt template with `{{title}}` and `{{body}}` substituted.
- [x] 4.3 Invoke `deps.runHarness` with the rendered prompt; parse the response as JSON.
- [x] 4.4 Validate the parsed response has at minimum `title` (string), `body` (string), and `milestone` (string or null); exit non-zero with a clear error if the shape is wrong.
- [x] 4.4b Validate body structure: check all four required section headings (`## Summary`, `## User story`, `## Acceptance criteria`, `## Out of scope`) are present and at least one `- [ ]` item exists anywhere in the body; exit non-zero with a clear error if either check fails, with nothing written to stdout.
- [x] 4.5 Write the validated JSON object as a single unfenced JSON string to stdout; exit 0.
- [x] 4.6 On any harness or parse error: exit non-zero with an error message; do not write partial JSON to stdout.

## 5. Unit tests (`core/test/refine-spec.test.ts`)

- [x] 5.1 Happy path: given valid title and body, `runHarness` is called once; stdout is a valid JSON object with `title`, `body`, and `milestone` fields; exit code is 0.
- [x] 5.2 Missing `--title`: exits non-zero with a usage error; no harness call made.
- [x] 5.3 Missing `--body`: exits non-zero with a usage error; no harness call made.
- [x] 5.4 Harness failure (throws): exits non-zero; no JSON written to stdout.
- [x] 5.5 Harness returns malformed JSON: exits non-zero with a parse error; no partial JSON written.
- [x] 5.6 Harness returns JSON missing a required field: exits non-zero with a shape error.
- [x] 5.7 No filesystem, git, or GitHub calls are made in any code path (verified by the absence of write-capable slots in the fake deps).

## 6. Documentation

- [x] 6.1 Add `refine-spec` to the sub-command table in `README.md` (flags: `--title`, `--body`; behavior: non-mutating spec refinement; JSON output; discovery via `--help`).
- [x] 6.2 Add `refine-spec` to `hosts/claude/SKILL.md` (usage line + example).

## 7. Mirror + CI

- [x] 7.1 `node scripts/build.mjs`; verify mirror is in sync.
- [x] 7.2 `npm run ci` green end-to-end.
