## Context

`testgate.ts` has two execution paths for the test command:

1. **Auto-detected** (no `test_gate.command` in config): `detectTestCommand()` returns a `ParsedCommand { cmd, args }` built from repo heuristics (package.json scripts, go.mod, Cargo.toml, etc.). This is passed directly to `runCapped(cmd, args, …)` — no shell, no injection surface.
2. **Configured** (`test_gate.command` set): `shellSplit(raw)` tokenizes the string into `{ cmd, args }` and the result is passed the same way. No shell is invoked.

Path (2) is the bug. Shell operators (`&&`, `||`, `;`, `|`, `>`) are not special inside `runCapped` — they become literal argv tokens. The `eval_gate` already uses the correct pattern: `runCapped("sh", ["-c", shellCmd], …)`.

## Goals / Non-Goals

**Goals:**
- Configured `test_gate.command` values are run through a POSIX shell (`sh -c`), making all standard shell operators valid.
- Auto-detected commands continue to use the direct-spawn path (no shell overhead, no injection surface on heuristic-derived tokens).
- The fix is surgical — minimal blast radius, no config schema changes.

**Non-Goals:**
- Removing or deprecating `shellSplit` (it is still used by auto-detection, tests, and `formatCommand`).
- Changing the eval gate (already correct).
- Supporting Windows-only shell operators or non-POSIX shells.
- Adding a new config key (no `shell: true/false` toggle — the configured path always uses a shell; this is the only sensible semantic).

## Decisions

**Decision: run configured commands via `sh -c` instead of the custom tokenizer.**
The configured value comes directly from the operator (pipeline.yml under version control). The operator is responsible for quoting and escaping — the same contract as any other shell config value (CI yaml `run:` fields, Makefile rules, etc.). Using `sh -c` gives operators the full POSIX shell feature set they already expect and documents. The alternative — expanding `shellSplit` to handle `&&`/`||`/`;` — would be re-implementing a shell parser, badly. Eval gate already proves `sh -c` is the right pattern here.

**Decision: keep the direct-spawn path for auto-detected commands.**
Auto-detected commands are constructed by the pipeline from known-safe tokens (`pnpm run test`, `go test ./...`, etc.), so there is no injection risk and no shell required. Keeping direct spawn avoids adding a shell layer to a purely programmatic path.

**Decision: no config schema change.**
`test_gate.command` is already a free-form string. Making it shell-evaluated is a behavioral fix, not a new feature. Operators who previously wrote `test_gate.command: "npm run ci"` (single-token, worked by accident) continue to work identically.

## Risks / Trade-offs

- *Operator shell injection* — The command comes from `.github/pipeline.yml`, a file checked into the repo under developer control, not from untrusted user input. The risk posture is identical to CI `run:` blocks. No change in trust boundary.
- *`sh` availability* — `sh` is POSIX-mandated and present on every supported platform (macOS, Linux). The doctor preflight does not need a new check.
- *Existing single-token commands change behavior* — `npm run ci` through `sh -c` is semantically identical to direct spawn for a single command with no special characters. Exit code, stdout, stderr, and working directory are all preserved.
