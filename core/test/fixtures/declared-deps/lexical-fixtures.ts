// Shared table-driven fixtures for the declared-dependency lexical grammar
// (#905). Loop and roadmap consumers run the same rows and must produce
// identical prerequisite id sets (modulo fixed inventory filtering).

export interface LexicalFixtureRow {
  /** Short name for the assertion message. */
  name: string;
  /** Free text (title and/or body). */
  text: string;
  /** Optional self-id so self-references are ignored. */
  selfId?: string;
  /** Expected stable, normalized, deduplicated prerequisite ids. */
  expected: readonly string[];
}

/** Synthetic rows covering punctuation, multi-ref, case, self-ref, sections. */
export const LEXICAL_FIXTURE_ROWS: readonly LexicalFixtureRow[] = [
  {
    name: "single-ref depends on (legacy #615)",
    text: "Depends on #607 for the evaluator isolation work.",
    expected: ["607"],
  },
  {
    name: "colon and comma multi-reference",
    text: "Depends on: #12, #13",
    expected: ["12", "13"],
  },
  {
    name: "colon-form list begins on next line (LF)",
    text: "Depends on:\n#12, #13",
    expected: ["12", "13"],
  },
  {
    name: "colon-form list begins on next line (CRLF)",
    text: "Depends on:\r\n#12 and #13",
    expected: ["12", "13"],
  },
  {
    name: "unpunctuated and-joined multi-reference",
    text: "Depends on #12 and #13",
    expected: ["12", "13"],
  },
  {
    name: "requires / blocked by / needs multi-ref",
    text: "requires #1, #2\nblocked by #3 and #4\nneeds #5, #6 and #7",
    expected: ["1", "2", "3", "4", "5", "6", "7"],
  },
  {
    name: "case-insensitive phrase",
    text: "DEPENDS ON #10 and #11",
    expected: ["10", "11"],
  },
  {
    name: "writeback-style blocked by multi-ref",
    text: "_(blocked by #607, #608)_",
    expected: ["607", "608"],
  },
  {
    name: "separate phrases not absorbed as one list",
    text: "It is blocked by #12 and needs #3 before merge.",
    expected: ["12", "3"],
  },
  {
    name: "self-reference and duplicates",
    text: "Depends on #608, #607, #607",
    selfId: "608",
    expected: ["607"],
  },
  {
    name: "dependency section captures bare refs",
    text: [
      "## Problem",
      "See unrelated issue #999 in the narrative.",
      "",
      "## Dependency",
      "#607 must land first.",
      "",
      "## Dependencies",
      "Also #100 and #200.",
      "",
      "## Acceptance",
      "Reference #300 only here.",
    ].join("\n"),
    expected: ["607", "100", "200"],
  },
  {
    name: "unrelated prose does not invent edges",
    text: [
      "Issue #42 is related history.",
      "The PR for #99 landed last week.",
      "See #1 in the design doc.",
    ].join("\n"),
    expected: [],
  },
  {
    name: "non-canonical ids dropped",
    text: "Depends on #007 and #0 and #12",
    expected: ["12"],
  },
  {
    name: "first-seen order with mixed phrase and section",
    text: "Depends on #2. Requires #1. Depends on #2 again.\n## Dependency\n#1 #3",
    expected: ["2", "1", "3"],
  },
  {
    name: "empty input",
    text: "",
    expected: [],
  },
  {
    name: "multi-ref space-separated without and/comma",
    text: "Depends on #8 #9",
    expected: ["8", "9"],
  },
];
