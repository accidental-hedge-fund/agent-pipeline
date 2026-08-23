## MODIFIED Requirements

### Requirement: `pipeline:loop` packaging SHALL NOT claim seconds-only runs or forbid Monitor

Host packaging for multi-item drive and resume of `pipeline loop` SHALL treat the
operation as long-running. Host skill guidance for drive and resume SHALL NOT claim
that the command “completes in seconds” and SHALL NOT instruct harnesses that “no
background process or Monitor is needed.” Read-only `--audit` MAY remain documented
as a short synchronous mode. This requirement SHALL NOT depend on generated Claude
command docs or on `plugin/pipeline/commands/pipeline:loop.md`.

#### Scenario: Generated loop command omits the fast-path falsehood

- **WHEN** the Claude or Codex host SKILL describes `pipeline loop` drive or resume
- **THEN** that guidance SHALL NOT contain the substring “completes in seconds”
  (case-insensitive)
- **AND** SHALL NOT contain the substring “No background process or Monitor needed”
  (case-insensitive)

#### Scenario: Plugin command mirror matches the long-running classification

- **WHEN** `scripts/build.mjs` is run
- **THEN** it SHALL NOT write `plugin/pipeline/commands/pipeline:loop.md`
- **AND** long-running or event-follow guidance SHALL live on the host SKILL (or CLI docs), not on a slash-command file

#### Scenario: Audit mode stays synchronous

- **WHEN** host or command docs describe `pipeline loop --audit`
- **THEN** they MAY document that mode as read-only and seconds-long
- **AND** they SHALL NOT use that audit guidance as the orchestration rule for
  drive or resume
