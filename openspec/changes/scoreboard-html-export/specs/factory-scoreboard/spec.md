## ADDED Requirements

### Requirement: Factory scoreboard supports a self-contained offline HTML export

The `pipeline scoreboard` command SHALL accept an optional `--html <path>` flag. When
supplied, the command SHALL write exactly one complete HTML document to `<path>` rendering
the report for the selected window, and SHALL exit successfully.

The written document SHALL be self-contained and offline: it SHALL contain no external
script, stylesheet, font, image, or other external resource reference; no `@import`; no
absolute or protocol-relative URL; and no runtime network call such as `fetch` or
`XMLHttpRequest`. All styling SHALL be inline within the document. The document SHALL
render completely with networking unavailable.

The command SHALL continue to write its existing human or `--json` output to stdout when
`--html` is supplied; `--html` SHALL be additive rather than a mode switch.

#### Scenario: HTML export writes one complete document

- **WHEN** `pipeline scoreboard --html report.html` is invoked against a repository with run artifacts
- **THEN** the command SHALL exit with status `0`
- **AND** `report.html` SHALL contain a complete HTML document beginning with `<!DOCTYPE html>` and ending with `</html>`

#### Scenario: exported document references no external resource

- **WHEN** a scoreboard HTML export is produced
- **THEN** the document SHALL contain no `<script>` element and no external script reference
- **AND** the document SHALL contain no stylesheet link, `@import`, or external font/image reference
- **AND** the document SHALL contain no `http://`, `https://`, or protocol-relative resource identifier
- **AND** the document SHALL contain no `fetch(` or `XMLHttpRequest` call

#### Scenario: exported document renders offline

- **WHEN** the exported document is opened with networking unavailable
- **THEN** the full report SHALL render
- **AND** every styling rule SHALL be present inline within the document

### Requirement: Scoreboard HTML export reports the same metric values as the terminal report

The HTML export SHALL be rendered from the same report object that produces the command's
human and `--json` output for that invocation, so that no additional scan or aggregation
occurs. For a given window and set of run artifacts, every metric value the command reports
to the terminal SHALL appear in the exported document with the same value.

The export SHALL apply the capability's existing zero-denominator rule: a rate whose
`ratio` is `null` and a duration whose `avg_ms` is `null` SHALL be rendered as an explicit
not-applicable marker, and SHALL NOT be rendered as `0`.

The export SHALL use generic Agent Pipeline terminology and run-artifact-derived values
only, and SHALL NOT introduce organization-, customer-, or branding-specific content, and
SHALL NOT introduce metrics that the terminal report does not compute.

The export SHALL honour the command's other window and shaping flags: `--since`, `--until`,
`--days`, `--estimate-cost`, `--bucket`, and `--by` SHALL affect the exported document
exactly as they affect the terminal report.

#### Scenario: exported values match the terminal report

- **WHEN** `pipeline scoreboard --html report.html` is invoked for a given window and set of run artifacts
- **THEN** every metric value present in the command's human output SHALL appear in `report.html` with the same value

#### Scenario: zero-denominator metrics are rendered as not applicable

- **WHEN** the window contains no runs contributing to a given rate or duration metric
- **THEN** that metric SHALL be rendered in the exported document as an explicit not-applicable marker
- **AND** that metric SHALL NOT be rendered as `0`

#### Scenario: window and shaping flags apply to the export

- **WHEN** `pipeline scoreboard --days 7 --bucket day --by harness --html report.html` is invoked
- **THEN** `report.html` SHALL reflect the same 7-day window, per-period series, and per-harness grouping the terminal report shows for the same invocation

#### Scenario: run-derived strings are escaped

- **WHEN** a run artifact contributes a stage, harness, group key, or diagnostic string containing HTML metacharacters such as `<`, `&`, or `"`
- **THEN** those characters SHALL be escaped in the exported document
- **AND** the string SHALL NOT be interpreted as markup

### Requirement: Scoreboard HTML export never publishes or mutates state

The HTML export SHALL be read-only with respect to all state other than the destination
file. It SHALL NOT invoke any GitHub command, SHALL NOT create, modify, or delete any file
under `.agent-pipeline/runs/`, and SHALL NOT upload, publish, email, or otherwise transmit
the report or any run artifact to any external system.

When `--html` is omitted, the command SHALL behave exactly as before: no file SHALL be
written, and human and `--json` output SHALL be unchanged.

#### Scenario: export mutates nothing but the destination file

- **WHEN** `pipeline scoreboard --html report.html` is invoked
- **THEN** no GitHub command SHALL be invoked
- **AND** no file under `.agent-pipeline/runs/` SHALL be created, modified, or deleted
- **AND** no data SHALL be transmitted to any external system

#### Scenario: omitting the flag changes nothing

- **WHEN** `pipeline scoreboard` or `pipeline scoreboard --json` is invoked without `--html`
- **THEN** the output SHALL be identical to the output produced before this capability was added
- **AND** no file SHALL be written

### Requirement: Scoreboard HTML export writes atomically and fails clearly on invalid paths

The export SHALL render the complete document before writing any bytes, SHALL write to a
temporary file within the destination's own directory, and SHALL rename that temporary file
onto the destination, so that the destination is never observed partially written.

When the destination path is invalid or unwritable — including a non-existent parent
directory, a destination that is an existing directory, or a directory the process cannot
write to — the command SHALL exit non-zero with an error message naming the destination
path, SHALL remove any temporary file it created, and SHALL leave no partial file at the
destination. The command SHALL NOT create missing parent directories.

Repeated exports over unchanged inputs — the same run artifacts, window bounds, and flags —
SHALL render the same metric values. The export SHALL NOT embed values derived from the
current clock, randomness, or the environment that would vary between such exports.

#### Scenario: invalid destination path fails without a partial file

- **WHEN** `pipeline scoreboard --html <path>` is invoked and `<path>`'s parent directory does not exist, or `<path>` is an existing directory, or the destination directory is not writable
- **THEN** the command SHALL exit non-zero with an error naming `<path>`
- **AND** no file SHALL exist at `<path>` as a result of the invocation
- **AND** no temporary file SHALL remain beside `<path>`

#### Scenario: a failure during writing leaves no partial file

- **WHEN** the export fails after starting to write the temporary file
- **THEN** the temporary file SHALL be removed
- **AND** any pre-existing file at the destination SHALL be left unchanged

#### Scenario: repeated exports over unchanged inputs are stable

- **WHEN** `pipeline scoreboard --html report.html` is invoked twice with identical flags and explicit window bounds over an unchanged run store
- **THEN** the rendered metric values SHALL be the same in both exports
