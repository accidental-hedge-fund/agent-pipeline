// Tests for the shared spec-generation output guard (#401): extraction of the
// final spec document from raw harness output, and capture-shaped-failure
// classification. Pure functions — no network/git/subprocess I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSpecDocument, isCaptureShaped, REQUIRED_SPEC_SECTIONS } from "../scripts/stages/spec-output.ts";
import { validateSpecBody } from "../scripts/stages/intake.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INTAKE_SHAPED_SPEC = [
  "# Add retry logic to the fix loop",
  "",
  "## Summary",
  "A retry mechanism for the fix loop that recovers from transient failures.",
  "",
  "## User story",
  "As a pipeline operator,",
  "I want the fix loop to retry on transient errors,",
  "so that a temporary network failure does not block the run.",
  "",
  "## Acceptance criteria",
  "- [ ] Running `pipeline N` with a transient fix error retries up to 3 times.",
  "- [ ] A permanent error still blocks with a clear message.",
  "",
  "## Out of scope",
  "- Retry logic for the planning or review stages.",
].join("\n");

// Sweep's expected shape omits the title line (the issue title is already set).
const SWEEP_SHAPED_SPEC = INTAKE_SHAPED_SPEC.split("\n").slice(2).join("\n");

const NARRATION_AND_TOOL_BLOCK = [
  "Let me check the relevant code for accurate terminology before writing the spec.",
  "",
  "**Tool: bash**",
  "",
  "Input:",
  "```json",
  '{"command":"grep -rn \\"classifyComment\\" core/scripts --include=\\"*.ts\\""}',
  "```",
  "",
  "Output:",
  "```",
  "core/scripts/stages/review.ts:142: function classifyComment(...)",
  "```",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// extractSpecDocument
// ---------------------------------------------------------------------------

test("extractSpecDocument: narration and a tool-call block preceding a titled spec are stripped", () => {
  const raw = NARRATION_AND_TOOL_BLOCK + "\n" + INTAKE_SHAPED_SPEC;
  const extracted = extractSpecDocument(raw);
  assert.equal(extracted, INTAKE_SHAPED_SPEC);
  for (const section of REQUIRED_SPEC_SECTIONS) {
    assert.ok(extracted.includes(section), `extracted body must contain ${section}`);
  }
  assert.ok(!extracted.includes("**Tool: bash**"), "extracted body must not contain the tool-call block");
  assert.ok(!extracted.includes("Let me check"), "extracted body must not contain the narration line");
});

test("extractSpecDocument: narration and a tool-call block preceding a title-less (sweep) spec are stripped", () => {
  const raw = NARRATION_AND_TOOL_BLOCK + "\n" + SWEEP_SHAPED_SPEC;
  const extracted = extractSpecDocument(raw);
  assert.equal(extracted, SWEEP_SHAPED_SPEC);
  for (const section of REQUIRED_SPEC_SECTIONS) {
    assert.ok(extracted.includes(section), `extracted body must contain ${section}`);
  }
  assert.ok(!extracted.includes("**Tool: bash**"), "extracted body must not contain the tool-call block");
});

test("extractSpecDocument: clean output with no leading narration is returned unchanged", () => {
  assert.equal(extractSpecDocument(INTAKE_SHAPED_SPEC), INTAKE_SHAPED_SPEC);
  assert.equal(extractSpecDocument(SWEEP_SHAPED_SPEC), SWEEP_SHAPED_SPEC);
});

test("extractSpecDocument: clean output tolerates surrounding whitespace", () => {
  assert.equal(extractSpecDocument(`\n\n  ${INTAKE_SHAPED_SPEC}  \n\n`), INTAKE_SHAPED_SPEC);
});

test("extractSpecDocument: no anchor found — returns the trimmed input unchanged", () => {
  const raw = "  Just some prose with no spec sections at all.  ";
  assert.equal(extractSpecDocument(raw), raw.trim());
});

// ---------------------------------------------------------------------------
// Regression: extraction strips narration/tool-call artifacts that would
// otherwise leak into the spec body, while the required sections still pass
// validation (#401 — proves extraction actually bites on the artifact it
// targets: body cleanliness, not section presence — a substring-based
// section check can never be made to pass by trimming a prefix off text that
// already failed it, so the fixture below proves the narrower, real claim).
// ---------------------------------------------------------------------------

test("regression: raw narration+tool-block+spec output leaks the tool-call block; extraction strips it while all sections still pass", () => {
  const raw = NARRATION_AND_TOOL_BLOCK + "\n" + INTAKE_SHAPED_SPEC;
  const extracted = extractSpecDocument(raw);

  assert.notEqual(extracted, raw.trim(), "extraction must actually remove the leading narration/tool-call block");
  assert.ok(raw.includes("**Tool: bash**"), "sanity: the raw output carries the tool-call block");
  assert.ok(!extracted.includes("**Tool: bash**"), "extracted body must not leak the tool-call block");
  assert.ok(!extracted.includes("Let me check"), "extracted body must not leak the narration line");
  assert.doesNotThrow(() => validateSpecBody(extracted), "extracted body must pass section validation");
});

// ---------------------------------------------------------------------------
// 2026-07-07 sweep failure reproductions (#398, #390): the raw evidence quoted
// in the issue is a narration line + a **Tool: bash** block + fenced ```json
// command, ahead of the real spec. Both must extract to a valid four-section
// spec via extractSpecDocument.
// ---------------------------------------------------------------------------

const ISSUE_390_NARRATION = [
  "Let me check the relevant code for accurate terminology before writing the spec.",
  "",
  "**Tool: bash**",
  "",
  "Input:",
  "```json",
  '{"command":"grep -rn \\"classifyComment\\\\|unacknowledged human\\\\|Scope override\\" core/scripts --include=\\"*.ts\\""}',
  "```",
].join("\n");

const ISSUE_390_SPEC = [
  "## Summary",
  "Classify unacknowledged human review comments and scope overrides using the terminology the review pipeline already uses.",
  "",
  "## User story",
  "As a pipeline reviewer,",
  "I want unacknowledged human comments and scope overrides classified with the codebase's existing terms,",
  "so that a re-spec does not invent new vocabulary the review stage does not recognize.",
  "",
  "## Acceptance criteria",
  "- [ ] An unacknowledged human comment is classified using the `classifyComment` terminology already in `core/scripts`.",
  "- [ ] A scope-override comment is classified distinctly from a routine review comment.",
  "",
  "## Out of scope",
  "- Changes to the review UI or comment rendering.",
].join("\n");

const ISSUE_398_NARRATION = [
  "Let me check the timeout handling code before writing the spec.",
  "",
  "**Tool: bash**",
  "",
  "Input:",
  "```json",
  '{"command":"grep -rn \\"runCapped\\\\|timed_out\\" core/scripts --include=\\"*.ts\\""}',
  "```",
].join("\n");

const ISSUE_398_SPEC = [
  "## Summary",
  "Ensure `runCapped` reports a distinct timed-out result so callers can tell a timeout apart from a genuine process failure.",
  "",
  "## User story",
  "As a pipeline operator,",
  "I want a timed-out harness call reported distinctly from a failed one,",
  "so that blocked reasons in the sweep/intake report are accurate.",
  "",
  "## Acceptance criteria",
  "- [ ] `runCapped` sets `timed_out: true` when the process is killed for exceeding its timeout.",
  "- [ ] A non-timeout process failure does not set `timed_out`.",
  "",
  "## Out of scope",
  "- Changing the default timeout values.",
].join("\n");

test("regression (#398/#390): 2026-07-07 sweep failure transcripts extract to valid four-section specs", () => {
  for (const [label, raw] of [
    ["#390", ISSUE_390_NARRATION + "\n\n" + ISSUE_390_SPEC],
    ["#398", ISSUE_398_NARRATION + "\n\n" + ISSUE_398_SPEC],
  ] as const) {
    const extracted = extractSpecDocument(raw);
    assert.notEqual(extracted, raw.trim(), `${label}: extraction must remove the leading narration/tool-call block`);
    assert.doesNotThrow(() => validateSpecBody(extracted), `${label}: extracted body must pass section validation`);
    assert.ok(!extracted.includes("**Tool: bash**"), `${label}: extracted body must not contain the tool-call block`);
  }
});

// ---------------------------------------------------------------------------
// isCaptureShaped
// ---------------------------------------------------------------------------

test("isCaptureShaped: tool-call markers present and no valid spec extracted — true", () => {
  const raw = NARRATION_AND_TOOL_BLOCK + "\n## Summary\nA thing that never finishes the required sections.";
  assert.ok(isCaptureShaped(raw));
});

test("isCaptureShaped: plain incomplete spec with no narration/tool-call markers — false", () => {
  const raw = "## Summary\nA thing.\n\n## Acceptance criteria\n- [ ] works.";
  assert.ok(!isCaptureShaped(raw), "a genuinely incomplete spec with no capture markers is a content failure, not capture-shaped");
});

test("isCaptureShaped: clean, complete spec — false", () => {
  assert.ok(!isCaptureShaped(INTAKE_SHAPED_SPEC));
  assert.ok(!isCaptureShaped(SWEEP_SHAPED_SPEC));
});

test("isCaptureShaped: a leading 'Let me ' preamble with an incomplete spec is capture-shaped", () => {
  const raw = "Let me look at the existing terminology first.\n\n## Summary\nA thing.\n## Acceptance criteria\n- [ ] works.";
  assert.ok(isCaptureShaped(raw));
});

test("isCaptureShaped: narration/tool markers present but extraction already recovered a complete spec — false", () => {
  const raw = NARRATION_AND_TOOL_BLOCK + "\n" + INTAKE_SHAPED_SPEC;
  assert.ok(!isCaptureShaped(raw), "extraction already fixed this output — no retry should be spent on it");
});
