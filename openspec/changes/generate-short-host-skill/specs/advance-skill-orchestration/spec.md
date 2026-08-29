## MODIFIED Requirements

### Requirement: Single-issue advance host packaging SHALL specify detach, follow, re-attach, stop, and summarize

The shared orchestration-contract source and each generated host SKILL SHALL specify an ordered harness follow/notify protocol for default-mode single-issue advance that includes at least: capture `run_id`, follow `pipeline logs <run-id> --events --follow` (or the equivalent events follow), re-attach after a cancelled wait, stop on a terminal run event, and emit a final summary. Generated SKILLs SHALL NOT be required to contain §4 bash discovery scripts. The contract SHALL NOT instruct the host to treat default advance as fire-and-forget without follow-to-terminal. The follower SHALL NOT invoke a merge-capable command.

#### Scenario: Ordered advance orchestration steps are present

- **WHEN** an operator reads the generated SKILL or the shared orchestration-contract source
- **THEN** the text SHALL list capture `run_id`, event follow, re-attach after lost wait, stop on terminal, and final summary as ordered obligations
- **AND** SHALL NOT instruct the host to treat default advance as fire-and-forget without follow-to-terminal

#### Scenario: SKILL omits the bash essay

- **WHEN** a generated host SKILL is read
- **THEN** it SHALL NOT contain §4 bash discovery scripts
- **AND** it SHALL still require follow-until-terminal
