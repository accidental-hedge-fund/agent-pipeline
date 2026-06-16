## MODIFIED Requirements

### Requirement: Command resolution — explicit override, else auto-detection
The command SHALL be the explicit `cfg.test_gate.command` (run via `sh -c`; the shell parses the string and the pipeline SHALL NOT tokenize it before spawning) when set; otherwise it SHALL be auto-detected with a defined precedence: a real `package.json` `test` script (package manager chosen from the lockfile — `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, else npm; a placeholder/echo-only `test` script falls back to a build/typecheck script), then `go.mod`→`go test ./...`, `Cargo.toml`→`cargo test`, a concrete pytest marker→`pytest`, a `Makefile` `test:` target→`make test`. Auto-detected commands SHALL be spawned directly without shell wrapping.

#### Scenario: explicit override bypasses detection
- **WHEN** `cfg.test_gate.command` is set
- **THEN** that command SHALL be executed via `sh -c` and auto-detection SHALL be skipped

#### Scenario: detect package.json test with pnpm lockfile
- **WHEN** the worktree has a `package.json` `test` script and a `pnpm-lock.yaml`
- **THEN** the detected command SHALL run the test script via pnpm

#### Scenario: placeholder test script falls back
- **WHEN** the `package.json` `test` script is an npm placeholder (`echo "Error: no test specified" && exit 1`)
- **THEN** detection SHALL skip it and fall back to a build/typecheck script if present
