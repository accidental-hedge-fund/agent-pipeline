// Shared spec-output guard (#401): the sweep/intake spec-generation harness
// call sometimes returns the model's working narration — including
// text-shaped tool-call blocks — ahead of the final spec, all inside one lean
// turn (`invoke(..., { lean: true })` already runs tool-free; the model still
// narrates as if it had tools). This module extracts the final spec document
// from that raw output and classifies a still-invalid result as
// capture-shaped (a transcript-capture mechanic) vs. a genuine content
// failure, so callers know when a single bounded retry is worth spending.

/** Single-sourced so intake and sweep validate against the identical section list. */
export const REQUIRED_SPEC_SECTIONS = [
  "## Summary",
  "## User story",
  "## Acceptance criteria",
  "## Out of scope",
];

/**
 * Extract the final spec document from raw spec-generation harness output.
 *
 * Anchors on the earliest `# <title>` line that is followed (anywhere after
 * it) by a `## Summary` heading — intake's expected shape. When no such title
 * line precedes a `## Summary`, falls back to slicing from the first
 * `## Summary` heading — sweep's expected shape, which omits the title line
 * (the issue title is already set). Returns the trimmed input unchanged when
 * neither anchor is found.
 */
export function extractSpecDocument(raw: string): string {
  const trimmed = raw.trim();
  const lines = trimmed.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!/^# /.test(lines[i])) continue;
    const rest = lines.slice(i + 1).join("\n");
    if (rest.includes("## Summary")) {
      return lines.slice(i).join("\n").trim();
    }
  }

  const summaryIdx = lines.findIndex((l) => l.startsWith("## Summary"));
  if (summaryIdx !== -1) {
    return lines.slice(summaryIdx).join("\n").trim();
  }

  return trimmed;
}

function hasAllRequiredSections(body: string): boolean {
  return REQUIRED_SPEC_SECTIONS.every((s) => body.includes(s));
}

const TOOL_CALL_MARKER_RE = /\*\*Tool:/;
const JSON_COMMAND_BLOCK_RE = /```json[\s\S]*?"command"/;
const CONVERSATIONAL_PREAMBLE_RE = /^\s*Let me /;

/**
 * Classify a raw (pre-extraction) harness output as capture-shaped: true when
 * extraction still yields no spec containing all required sections AND the
 * raw output carries a narration/tool-call marker (a `**Tool:` marker, a
 * fenced ```json block containing a `"command"` key, or a leading "Let me "
 * preamble). A spec that fails validation with none of these markers is a
 * genuine content failure, not a transcript-capture mechanic, and is NOT
 * classified capture-shaped — callers should not spend a retry on it.
 */
export function isCaptureShaped(raw: string): boolean {
  if (hasAllRequiredSections(extractSpecDocument(raw))) return false;
  return (
    TOOL_CALL_MARKER_RE.test(raw) ||
    JSON_COMMAND_BLOCK_RE.test(raw) ||
    CONVERSATIONAL_PREAMBLE_RE.test(raw)
  );
}
