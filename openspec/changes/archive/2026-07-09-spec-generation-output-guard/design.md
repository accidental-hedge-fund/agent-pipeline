## Context

`sweep` and `intake` each make one lean spec-generation harness call and feed the
result to a section-validation contract. `sweep` passes `harnessResult.output`
straight to `validateSweepSpecBody`; `intake` runs it through `parseSpec` (which
does `body: raw.trim()` — no narration stripping) and then `validateSpecBody`.
Both invoke the harness lean (`invoke("claude", …, { lean: true, … })`), which
already appends `--tools ""` and `--strict-mcp-config`.

So the flags in hypothesis #1 from the issue are already applied. The observed
failure is hypothesis #2: the model, though genuinely tool-free, still emits a
narration preamble that *mimics* a tool call as plain text ("Let me check…",
`**Tool: bash**`, a fenced `json` command block) ahead of the real spec, all
inside its single message. `--output-format text` captures that whole message
verbatim, and neither call site strips the preamble before validation — so a
well-formed spec is rejected for "missing required sections" it actually
contains further down.

## Goals / Non-Goals

**Goals**
- Stop losing well-formed specs to leading narration by extracting the final spec
  document before validation, on both call sites, via one shared helper.
- Distinguish a capture-shaped mechanics failure from a genuine content failure,
  and spend a single bounded retry only on the former.
- Keep the existing section-validation contract as the unchanged backstop.
- Prove the spec-generation call remains tool-free with a drift-guard test.

**Non-Goals**
- Changing the section-validation contract (it worked correctly — it caught bad
  output).
- Improving spec *content* quality for issues that already generate successfully.
- The stale release-slot proposal from intake (#396 — separate defect, file
  separately if it recurs).
- Unbounded retry loops or a per-issue retry budget beyond one.

## Decisions

**Decision: content-based extraction, not a switch to `--output-format json`.**
Switching the harness to JSON output and reading the final `result` field would
not help: the narration and the spec live in the *same* final assistant message
(one lean turn, no tools), so the final message text still contains the preamble.
Extraction must therefore be content-based — locate where the spec document
begins and drop everything before it. Content-based extraction is also
harness-agnostic (works if a codex-backed spec-gen path is ever added) and needs
no host-specific envelope parsing.

**Decision: define spec-start as the title/first-required-section anchor.**
The extraction locates the earliest `# <title>` line that is followed (anywhere
after it) by a `## Summary` heading, and slices from there; if no such title
exists, it falls back to slicing from the first `## Summary`. This anchors on the
canonical spec shape the prompt already asks for, rather than trying to
enumerate every narration/tool-call marker to strip. Everything before the anchor
— narration, fake tool blocks — is discarded by construction.

**Decision: capture-shaped classification gates the retry, not validation alone.**
Retrying on *any* validation failure would waste a model call whenever the model
simply produced a thin/incomplete spec. The guard only triggers the retry when
extraction still yields no complete spec AND the raw output carries
narration/tool-call markers (`**Tool:`, a fenced `json` block with a `"command"`
key, or a leading "Let me " preamble). That keeps the retry targeted at the
transcript-capture mechanic the issue describes.

**Decision: bounded single retry, then block as today.**
One retry is enough to clear an intermittent narration preamble without risking a
non-converging loop or unbounded token spend. A second capture-shaped result
falls through to the existing "missing required sections" block path, so the
issue is surfaced rather than silently dropped. The retry is per-issue and does
not change the `sweep`/`intake` timeout contracts (each call is still bounded by
`cfg.sweep_timeout` / `cfg.intake_timeout`).

**Decision: one shared helper, used by both call sites.**
`sweep.ts` already imports helpers from `intake.ts`, so a small shared module
(e.g. `core/scripts/stages/spec-output.ts`) exporting `extractSpecDocument()` and
`isCaptureShaped()` avoids duplicating the logic. `intake.parseSpec` and the
`sweep` harness path both call `extractSpecDocument()` before their existing
validators; the retry loop wraps each call site's single harness invocation.

## Risks / Trade-offs

- *Extraction false-positive (narration contains a stray `## Summary`)* → The
  anchor scan could slice at a heading inside narration. Mitigation: anchor on a
  `# <title>` that is followed by `## Summary`, matching the prompt's required
  shape; the section-validation backstop still rejects anything incomplete after
  slicing.
- *Capture-classifier drift* → Marker heuristics (`**Tool:`, `json` command
  block) could miss a new narration shape. Mitigation: classification only gates
  the *retry*; a miss degrades to today's immediate block, never to accepting bad
  output. Markers are covered by unit tests using the real #398/#390 transcripts.
- *Extra latency on capture-shaped issues* → One additional harness call per
  affected issue. Bounded to one; only paid when markers are present; far cheaper
  than a manual per-issue re-spec.

## Migration / Compatibility

No config or CLI surface changes. The freeform (non-OpenSpec) path is untouched.
The guard is purely additive between the existing harness call and the existing
validators, so repos that never hit capture-shaped output see identical behavior.
