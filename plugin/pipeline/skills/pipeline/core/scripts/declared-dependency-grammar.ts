// Single exported deterministic lexical dependency grammar (#905, capability
// `declared-dependency-grammar`).
//
// Loop work-list discovery and roadmap textual candidate discovery both call
// {@link parseDeclaredDependencyIds}. This module owns the phrase + section
// grammar only — pure, network-free, no git/subprocess. Consumers convert shape
// and apply in-snapshot filtering after parse.

// Canonical GitHub issue id: plain decimal digits, no leading zero (same gate
// spirit as external-dependency verification in loop/dependencies.ts).
const CANONICAL_ISSUE_ID_RE = /^[1-9][0-9]*$/;

/**
 * Case-insensitive dependency phrase head. Optional colon after the phrase is
 * accepted so forms such as `Depends on: #12, #13` parse completely.
 */
const PHRASE_HEAD_RE = /(?:depends on|requires|blocked by|needs)\s*:?/gi;

/** ATX heading for a dedicated dependency section (any heading level). */
const DEP_SECTION_HEADING_RE = /^#{1,6}\s+dependenc(?:y|ies)\b[^\n]*$/gim;

const ISSUE_REF_RE = /#(\d+)/g;

/**
 * After a dependency phrase, consume one or more `#N` references separated by
 * commas, whitespace, and/or the word `and`. Stops before non-list prose so a
 * later independent phrase (e.g. `and needs #3`) is not absorbed as a list
 * continuation.
 */
function consumeReferenceList(text: string, start: number): string[] {
  const ids: string[] = [];
  let pos = start;
  const len = text.length;

  // List-leading whitespace includes CR/LF so colon-form declarations whose
  // reference list begins on the next line (`Depends on:\n#12, #13`) parse
  // completely — same whitespace class as inter-reference separators below.
  while (pos < len && /\s/.test(text[pos]!)) pos += 1;

  const first = /^#(\d+)/.exec(text.slice(pos));
  if (!first || first[1] === undefined) return ids;
  ids.push(first[1]);
  pos += first[0].length;

  while (pos < len) {
    const rest = text.slice(pos);
    // Separator only when the next token is another `#N` — prevents absorbing
    // `and needs #3` as a list continuation after `blocked by #12`.
    const sep = /^(?:\s*,\s*|\s+and\s+|\s+)(?=#\d)/i.exec(rest);
    if (!sep) break;
    pos += sep[0].length;
    const next = /^#(\d+)/.exec(text.slice(pos));
    if (!next || next[1] === undefined) break;
    ids.push(next[1]);
    pos += next[0].length;
  }

  return ids;
}

/**
 * Extracts prerequisite issue ids from free text (title and/or body).
 *
 * Matches:
 * - Case-insensitive phrases: `depends on|requires|blocked by|needs` + optional
 *   `:` + a reference list of one or more `#N` (comma / `and` / whitespace
 *   separated). Every listed reference is preserved.
 * - `#N` references under a `## Dependency` / `## Dependencies` (any ATX level)
 *   section body (until the next ATX heading)
 *
 * Ignores self-references when `selfId` is provided, non-canonical ids, and
 * bare `#N` mentions outside phrase or dependency-section context. Returns
 * stable deduped string ids in first-seen order.
 */
export function parseDeclaredDependencyIds(text: string, selfId?: string): string[] {
  if (!text) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  const add = (raw: string): void => {
    if (!CANONICAL_ISSUE_ID_RE.test(raw)) return;
    if (selfId !== undefined && raw === selfId) return;
    if (seen.has(raw)) return;
    seen.add(raw);
    out.push(raw);
  };

  PHRASE_HEAD_RE.lastIndex = 0;
  let phraseMatch: RegExpExecArray | null;
  while ((phraseMatch = PHRASE_HEAD_RE.exec(text)) !== null) {
    const listStart = phraseMatch.index + phraseMatch[0].length;
    for (const id of consumeReferenceList(text, listStart)) {
      add(id);
    }
  }

  DEP_SECTION_HEADING_RE.lastIndex = 0;
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = DEP_SECTION_HEADING_RE.exec(text)) !== null) {
    const sectionStart = headingMatch.index + headingMatch[0].length;
    const rest = text.slice(sectionStart);
    const nextHeading = rest.search(/\n#{1,6}\s+\S/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    ISSUE_REF_RE.lastIndex = 0;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = ISSUE_REF_RE.exec(section)) !== null) {
      add(refMatch[1]!);
    }
  }

  return out;
}

/** True when `raw` is a canonical positive decimal issue id (no leading zeros). */
export function isCanonicalIssueId(raw: string): boolean {
  return CANONICAL_ISSUE_ID_RE.test(raw);
}
