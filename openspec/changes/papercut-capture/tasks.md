## 1. Config surface

- [ ] 1.1 Add an optional strict `papercuts` block to the config schema in `core/scripts/config.ts`
      (`z.object({ enabled: z.boolean().optional() }).strict().optional()`), placed alongside
      `event_sink` and documented with the same comment style.
- [ ] 1.2 Resolve it into `PipelineConfig` (`core/scripts/types.ts`) as a normalized
      `papercuts: { enabled: boolean }`, defaulting to disabled when the block is absent.
- [ ] 1.3 Emit the block in the config renderer (`renderConfig`/`configToObject` paths in
      `config.ts`) as a commented-out hint when unset, mirroring `event_sink`.
- [ ] 1.4 Tests in `core/test/config.test.ts`: `papercuts: { enabled: true }` resolves enabled; an
      unknown key inside the block throws a schema error naming the field; an absent block
      resolves disabled.

## 2. The `papercut` run event

- [ ] 2.1 Add `PapercutEvent` to `core/scripts/run-store.ts` with the shape specified in the delta
      (`schema_version`, `type`, `at`, `run_id`, `issue`, `stage`, `harness`, `model`, `message`)
      and add it to the `RunEvent` union.
- [ ] 2.2 Add `emitPapercut(runDir, payload, deps)` following the `emitHumanIntervention`
      total-function contract: constructs the record, calls `appendEvent`, catches and warns on
      any failure, never throws.
- [ ] 2.3 Tests in `core/test/run-store.test.ts` (or the new `papercut.test.ts`): the appended line
      carries every provenance field; a message containing a redactable secret is redacted and the
      event is still written; `emitPapercut` does not throw when `appendEvent` throws.

## 3. `pipeline papercut` sub-command

- [ ] 3.1 Add `core/scripts/stages/papercut.ts` with an injectable `PapercutDeps` seam
      (`appendEvent`/`emitPapercut`, `readFile`, `readdir`, `log`, `now`) — no direct fs/network in
      the pure logic, matching `AdvanceReviewDeps`/`VerifyDeps`.
- [ ] 3.2 Implement `recordPapercut(opts, deps)`: resolve the run directory from `--run <run-id>`
      via `runDirPath`, take stage/harness/model/issue defaults from the engine-supplied
      environment, emit the event, and return without ever throwing.
- [ ] 3.3 Implement `reportPapercuts(opts, deps)`: scan `.agent-pipeline/runs/*/events.jsonl`,
      parse lines, keep `type === "papercut"` events whose `at` falls in `[--since, --until]`,
      skip unreadable files and malformed lines, and return the array sorted by `at`.
- [ ] 3.4 Wire dispatch in `core/scripts/pipeline.ts`: recognize `papercut` as a no-issue-number
      sub-command, add `--run`, `-m/--message`, `--since`, `--until`, `--json` flags, print the
      report as a JSON array (`[]` when empty), and always exit zero on the record path.
- [ ] 3.5 Mark the Commander sub-command hidden so it is absent from `--help`, and do **not** add
      `papercut` to the namespaced host command list consumed by `scripts/build.mjs`.
- [ ] 3.6 Add the `papercut` entry to `COMMAND_REGISTRY` in `core/scripts/command-registry.ts`
      (`needsIssueNumber: false`, `needsConfig: true`, `needsGhAuth: false`,
      `mutatesGitHub: false`, `supportsJson: true`, allowlist `repoPath`, `profile`, `run`,
      `message`, `since`, `until`, `json`).
- [ ] 3.7 Tests in `core/test/papercut.test.ts`: record emits one event with the right fields;
      record exits zero and emits a warning when the append seam throws; report includes only
      in-window events; report over an empty window yields `[]`; malformed lines are skipped.
- [ ] 3.8 Test in `core/test/command-registry.test.ts` that `papercut` is registered, and a
      help-surface test asserting `--help` output contains no `papercut` entry.

## 4. Engine-supplied identity context

- [ ] 4.1 When `papercuts.enabled`, have the harness invocation in `core/scripts/harness.ts` add
      `PIPELINE_RUN_ID`, `PIPELINE_ISSUE`, `PIPELINE_STAGE`, `PIPELINE_HARNESS`, and
      `PIPELINE_MODEL` to the child process environment.
- [ ] 4.2 Test that the environment additions are present only when the feature is enabled and
      absent otherwise (no environment change on the default path).

## 5. Prompt instruction

- [ ] 5.1 Export a single `PAPERCUT_INSTRUCTION` constant from `core/scripts/prompts/index.ts`
      naming the exact CLI invocation and drawing the papercut / review-finding / blocker
      distinction.
- [ ] 5.2 Add a `{{papercut_instruction}}` placeholder to `implementing.md`, `fix.md`,
      `review_standard.md`, and `review_adversarial.md`, positioned so that substituting `""`
      leaves no stray blank line.
- [ ] 5.3 Substitute the constant when enabled and `""` when disabled in each prompt builder,
      following the `contextSnapshotSection()` pattern.
- [ ] 5.4 Tests in `core/test/prompt-loader.test.ts`: disabled rendering is byte-for-byte
      identical to the pre-change fixture for all three prompt families; enabled rendering
      contains the instruction; the injected text is the identical constant in all three
      (drift guard); the instruction text names all three categories.

## 6. Docs, mirror, gate

- [ ] 6.1 Document the `papercuts` config block and `pipeline papercut report` in `README.md`.
- [ ] 6.2 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 6.3 Run `npm run ci` from the repo root and confirm it is green (core tests, mirror check,
      install smoke, `openspec validate --all`).
