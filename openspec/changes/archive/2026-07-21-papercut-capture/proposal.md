## Why

Pipeline runs lose all record of small, non-blocking friction. A flaky command retried, a
misleading error worked around, an undocumented setup step, a dead-end tool call — none of it
trips `blocker_set` or `human_intervention`, so none of it survives the run. The agent silently
absorbs the cost, the next run pays it again, and the maintainer never sees the pattern.

The engine already has every primitive needed to capture this: an append-only `events.jsonl`
with redaction and an optional external sink (#343), a run-artifact contract where write
failures are non-fatal, a declarative command registry, and prompt templates whose optional
sections are config-gated. What is missing is a first-class *papercut* event, a way for an agent
to log one mid-run without stopping, and a way for a maintainer to read them back.

## What Changes

- Add a `papercut` event type to the run event union (`run-store.ts`), carrying the run, stage,
  harness/model identity that logged it, timestamp, and the agent's free-text message. It flows
  through the existing `appendEvent` path, so it inherits injection-denylist screening, secret
  redaction, and external-sink delivery unchanged.
- Add a `papercut` no-issue-number sub-command to the CLI:
  - `pipeline papercut --run <run-id> -m "<message>"` — record one papercut event.
  - `pipeline papercut report --since <date> [--until <date>] --json` — print the papercut
    events in that window as a JSON array.
- The `papercut` command is **agent-facing, not human-facing**: it is registered and directly
  invocable by name, but omitted from the `--help` sub-command listing and from the host
  `pipeline:<command>` surface, so it does not add noise to the operator's menu.
- Add an opt-in `papercuts` block to the `.github/pipeline.yml` schema (strict, unknown keys
  rejected, consistent with `event_sink`/`doctor`). Absent or `enabled: false` → the feature is
  inert.
- When enabled, inject a single-sourced papercut instruction into the implementing, fix, and
  review prompt templates via a `{{papercut_instruction}}` placeholder that renders the empty
  string when disabled (the `contextSnapshotSection` pattern). The instruction explicitly
  distinguishes a papercut (minor friction — log and continue) from a review finding (a defect)
  and from a blocker (work stopped).
- Recording a papercut is strictly best-effort: an I/O failure is caught, warned, and never
  surfaces as a stage failure, blocker, or non-zero run outcome.

## Capabilities

### New Capabilities

- `papercut-capture`: the `papercut` run event, the `pipeline papercut` record/report
  sub-command, the `papercuts` config block, and the config-gated single-sourced prompt
  instruction.

### Modified Capabilities

- `configurable-event-sink`: the enumeration of event producers that a configured sink receives
  gains `papercut`, so an operator-configured sink sees papercuts on the same terms as
  `blocker_set` and `human_intervention`.

## Impact

- `core/scripts/run-store.ts` — `PapercutEvent` type, union member, `emitPapercut` helper.
- `core/scripts/stages/papercut.ts` — new sub-command handler (record + report) with an
  injectable `PapercutDeps` seam.
- `core/scripts/pipeline.ts` — dispatch, flags (`--run`, `-m/--message`, `--since`, `--until`,
  `--json`), and the help-listing exclusion.
- `core/scripts/command-registry.ts` — `papercut` entry with its flag allowlist.
- `core/scripts/config.ts` — `papercuts` schema block, resolution, and config-render output.
- `core/scripts/prompts/index.ts` + `implementing.md`, `fix.md`, `review_standard.md`,
  `review_adversarial.md` — `{{papercut_instruction}}` placeholder and its single source.
- `core/test/papercut.test.ts`, plus additions to `prompt-loader.test.ts`, `config.test.ts`,
  `command-registry.test.ts`.
- `plugin/` mirror — regenerated.
- `README.md` — document the `papercuts` config block and the report command.

## Acceptance Criteria

- [ ] `pipeline papercut --run <run-id> -m "<message>"` invoked during a run records a `papercut`
      event tagged with that run and exits zero without blocking, pausing, or failing the run.
- [ ] A recorded papercut event contains the run id, the stage it occurred in, the harness/model
      identity that logged it, an ISO-8601 timestamp, and the free-text `-m` message.
- [ ] `pipeline papercut report --since <date> --json` prints a JSON array of papercut events
      whose timestamps fall inside the window; events outside the window are absent from the
      output.
- [ ] `pipeline papercut report --since <date> --json` over a window containing zero papercuts
      prints `[]` and exits zero — not an error.
- [ ] With an `event_sink.command` configured, a `papercut` event is delivered to that sink as
      the same JSON line as `blocker_set` and `human_intervention` events for the same run.
- [ ] A papercut message containing a known-redactable secret pattern is redacted (identically to
      other event types) before the line reaches `events.jsonl` or the sink, and the event is
      still written rather than dropped.
- [ ] `pipeline --help` output contains no `papercut` entry and the generated host
      `pipeline:<command>` surface contains no `pipeline:papercut` entry, yet
      `pipeline papercut --run <id> -m "x"` executes.
- [ ] When the papercut artifact write throws an I/O error, the invoking stage still completes,
      the run outcome is unchanged, and no `blocker_set` event is emitted as a result.
- [ ] With no `papercuts` block in `.github/pipeline.yml` (or `papercuts.enabled: false`), the
      rendered implementing, fix, and review prompts contain no papercut instruction text and are
      byte-for-byte identical to their pre-change output.
- [ ] With `papercuts.enabled: true`, the rendered implementing, fix, and review prompts each
      contain the papercut instruction, and the injected text is the identical string in all
      three (asserted against one exported constant).
- [ ] The rendered instruction text names all three categories and their different handling —
      papercut (minor friction: log and continue), review finding (a defect), blocker (work
      stopped) — verifiable by reading the rendered prompt.
- [ ] `.github/pipeline.yml` containing `papercuts: { enabled: true }` validates; a `papercuts`
      block containing an unrecognized key fails `resolveConfig()` with a schema error naming the
      offending field.

## Out of Scope

- Clustering papercuts into `pipeline:backlog` issues or any automated issue creation.
- Any scoreboard metric or UI surfacing papercut counts or rates.
- Mining `terminal.log` or other transcripts to infer friction — papercuts are agent-self-reported
  only.
- Any write to the target repo's files, including its human-curated lessons/conventions file.
- A human-facing dashboard or interactive browser beyond `--json` report output.
- Rate-limiting, deduplication, or capping how many papercuts a run may log.
