## Why

The documented operator surface for human-question work is `pipeline handoff <verb>`.
The shared extra-positionals guard currently allows one positional token.
The keyword `handoff` uses that budget, so the verb is rejected as an extra argument before the existing dispatch block runs.
Direct module invocation still works; it is not an accepted operator path.

This is a shared CLI admission-gate defect, not a handoff-handler defect.
The class is: a command with documented sub-verbs is omitted from the positional budget, so the extra-positionals guard rejects the verb before dispatch.
Issue #1349 implements that class for `handoff` so the documented argv reaches the existing handlers.

## What Changes

- Teach the shared extra-positionals gate that `handoff` has documented sub-verbs.
  The positional budget SHALL match that grammar, and extra tokens SHALL still fail before dispatch.
- Admit `pipeline handoff list` with the verb only.
- Admit `pipeline handoff show|answer|reject|supersede <handoff-id>` with the verb plus exactly one handoff ID.
- Reject a missing verb, an unknown verb, a missing required ID, and extra positional tokens with exit 2 before a read or a mutation.
- Keep flags such as `--issue` and `--json` as options, not positional tokens.
- Keep per-verb required flags, registry allowlists, authentication, idempotency, issue locking, Decisions materialization, and audit behavior unchanged.
- Update command-docs / generated CLI reference so the executable grammar for all five verbs is documented.
  Do not document a module-invocation workaround.
- Add CLI-level regression tests that run every documented verb through the real argument parser.

This issue does not rewrite the whole argument parser.
This issue does not change what `answer`, `reject`, or `supersede` writes.
This issue does not authorize a merge, a release, or a live Decisions-node attestation.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `human-question-handoff`: documented `pipeline handoff` argv SHALL reach the existing dispatch block.
  The shared positional gate SHALL admit `list` (verb only) and `show|answer|reject|supersede` (verb plus exactly one ID).
  Invalid argv SHALL fail with exit 2 before a read or a mutation.
  Authenticated handlers SHALL still enforce authentication.
  Handler mutation, idempotency, and audit semantics SHALL stay unchanged.
- `generated-cli-reference`: command-docs and generated `docs/cli.md` SHALL show the executable grammar for `list`, `show`, `answer`, `reject`, and `supersede`.
  They SHALL NOT document a module-invocation workaround.

## Acceptance criteria

- [ ] `pipeline handoff list --issue N --json` reaches `listHandoffs`.
- [ ] `pipeline handoff show <id> --issue N --json` reaches the read-only handler.
- [ ] `pipeline handoff answer <id> ...`, `pipeline handoff reject <id> ...`, and `pipeline handoff supersede <id> ...` reach their authenticated handlers when argv includes exactly one handoff ID and the existing required flags.
- [ ] `list` accepts no handoff ID. Extra positional tokens after `list` fail with exit 2 before a read.
- [ ] `show`, `answer`, `reject`, and `supersede` require exactly one handoff ID. A missing ID fails with exit 2. Extra positional tokens fail with exit 2 before a read for `show` and before mutation for `answer`, `reject`, and `supersede`.
- [ ] A missing verb, an unknown verb, or extra positionals fail with exit 2 before dispatch to a handler.
- [ ] Flags such as `--issue` and `--json` stay options and are not positional tokens.
- [ ] Existing per-verb required flags, registry allowlists, authentication, idempotency, issue locking, Decisions materialization, and audit behavior stay unchanged.
- [ ] Authenticated handlers still enforce authentication. This issue does not weaken auth. Invalid extra positionals never reach `answer`, `reject`, or `supersede`.
- [ ] `handoff answer`, `reject`, and `supersede` keep current mutation, idempotency, and audit semantics. This issue only makes the documented CLI argv able to reach them.
- [ ] CLI-level regression tests exercise every documented handoff verb through the real argument parser, not only handler unit tests. The tests fail if the positional guard still rejects the verb.
- [ ] An operator can answer a Decisions authority handoff through the CLI. The answer materializes the issue body and frontier. Verification uses the CLI parser plus existing handler and materialization seams with injected I/O. Verification does not require a live GitHub mutation in CI. This issue does not itself attest a live Decisions node.
- [ ] Command registry documentation metadata and generated docs include the executable grammar for `list`, `show`, `answer`, `reject`, and `supersede`. Do not document a module-invocation workaround.
- [ ] Advance stops at `pipeline:ready-to-deploy`. Merge stays a separate operator-authorized verb.
- [ ] `npm run ci` passes.

## Impact

- `core/scripts/pipeline.ts` — `maxPositionalsFor` and the shared extra-positionals guard so documented `handoff` argv reaches the existing `numArg === "handoff"` dispatch block.
- `core/scripts/command-docs.ts` — executable per-verb usage strings for generated `docs/cli.md`.
- `docs/cli.md` — regenerated from command-docs (no handwritten workaround).
- `core/test/` — CLI-parser regression tests for every documented verb and the rejection cases.
- Host SKILL freshness — `node scripts/build.mjs` after any `core/` edit.
- No change to `human-question-handoff.ts` handler semantics, `grill-handoff.ts` materialization, flag allowlists, locks, or merge/release authority.
- No audit or rewrite of unrelated commands unless they already fail this same omitted-budget rejection for documented sub-verbs.
- Next identical `handoff` fault does not need a new mole issue when that gate matches the documented grammar.
