## 1. Shared spec-output guard helper

- [ ] 1.1 Add `core/scripts/stages/spec-output.ts` exporting `extractSpecDocument(raw: string): string` — slices from the earliest `# <title>` line followed by a `## Summary`, falling back to the first `## Summary`; returns the input trimmed when no anchor precedes the spec.
- [ ] 1.2 Export `isCaptureShaped(raw: string): boolean` — true when the required sections are absent after extraction AND the raw output contains a `**Tool:` marker, a fenced `` ```json `` block with a `"command"` key, or a leading conversational preamble (e.g. `Let me `).
- [ ] 1.3 Keep the four required-section constants single-sourced (reuse/share the existing `REQUIRED_SPEC_SECTIONS` list rather than duplicating it).

## 2. Wire the guard into intake

- [ ] 2.1 In `intake.ts`, run `harnessResult.output` through `extractSpecDocument()` before `parseSpec`/`validateSpecBody` (so the extracted body is what reaches validation).
- [ ] 2.2 Wrap the single `d.runHarness` call in a bounded retry: on `isCaptureShaped()` (or extraction+validation failure that is capture-shaped), retry exactly once; on a second capture-shaped/invalid result, fall through to the existing block/error path. Non-capture failures block immediately (no retry).

## 3. Wire the guard into sweep

- [ ] 3.1 In `sweep.ts`, run `harnessResult.output` through `extractSpecDocument()` before `validateSweepSpecBody`; set `newBody` to the extracted (not raw) spec.
- [ ] 3.2 Apply the same bounded single-retry-on-capture-shaped logic around the per-issue `d.runHarness` call, preserving the existing `blocked` recording on final failure and the timeout/abort behavior.

## 4. Tool-free invocation drift-guard

- [ ] 4.1 Add a test asserting `realSweepDeps().runHarness` and `realIntakeDeps().runHarness` invoke `invoke()` with the lean option (`--tools ""` + `--strict-mcp-config`), using an injected `invoke` seam or arg-capture fake — no real subprocess.

## 5. Regression + unit tests

- [ ] 5.1 Regression test: feed a transcript-shaped output (narration + `**Tool: bash**` block + final four-section spec) through `extractSpecDocument()` and assert the returned body passes section validation and excludes the narration/tool block. Prove it bites (raw output fails validation without extraction).
- [ ] 5.2 Reproduce the 2026-07-07 cases: build transcript-shaped fixtures from the #398 and #390 bodies and assert extraction yields valid four-section specs.
- [ ] 5.3 `isCaptureShaped` unit tests: tool-call/narration output → true; plain incomplete spec (no markers) → false; clean valid spec → false.
- [ ] 5.4 Retry tests for both sweep and intake: first call capture-shaped + retry valid → proceeds, harness called twice; both capture-shaped → blocked, harness called twice (no third); non-capture invalid → blocked, harness called once.
- [ ] 5.5 Clean-output test: `extractSpecDocument()` on a spec with no leading narration returns it unchanged (modulo whitespace).

## 6. Mirror + full gate

- [ ] 6.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 6.2 Run `npm run ci` from the repo root and confirm green (core tests, mirror check, install smoke, `openspec validate --all`).
