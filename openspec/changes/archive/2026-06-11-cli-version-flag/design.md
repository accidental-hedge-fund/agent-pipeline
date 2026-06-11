## Context

The pipeline CLI is built on commander (v14) inside `core/scripts/pipeline.ts`. Commander provides a first-class `.version(str, flags, desc)` method that wires the flag, prints the string, and exits 0 — no custom action handler needed. The version string must be sourced from `core/package.json` at runtime so future `npm version` bumps are automatically reflected.

Node 24 native type-stripping is used (no `tsc`, no build step), so ESM `import` assertions or `createRequire` are the reading options.

## Goals / Non-Goals

**Goals:**
- Expose `--version` and `-V` on the root commander program.
- Source the version from `core/package.json` — single source of truth.
- No hardcoded version string anywhere in TypeScript.
- Unit test asserts the printed version equals `package.json`'s `version` field.

**Non-Goals:**
- Runtime environment info (Node version, OS) — keep output to the package version only.
- `--verbose` mode or additional metadata fields.
- Version flag on sub-commands (only needed on the root program).

## Decisions

### D1 — Use `createRequire` to read `package.json`

`import.meta.resolve` + `fs.readFileSync` or `createRequire` both work under ESM with no build step. `createRequire` is the idiomatic Node pattern for JSON in ESM:

```ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
```

The path is `../package.json` — i.e. `core/package.json` relative to `core/scripts/pipeline.ts`, **not** `../../` (which would resolve to the repo-root `package.json` in dev and a nonexistent file in the installed plugin). This is mirror-safe: `build.mjs` copies `package.json` alongside `scripts/` into `plugin/.../core/`, so the same relative path resolves in both the dev and installed layouts.

**Alternative considered**: `fs.readFileSync` with a relative path — works but is more fragile to file moves and requires manual JSON parsing. `createRequire` resolves via Node's module resolution, which is path-stable.

### D2 — Use commander's built-in `.version()`

Commander's `.version(version, '-V, --version', 'print version')` handles the flag, help text, and exit automatically. No custom `action` needed.

**Alternative considered**: Manual `if (args.includes('--version'))` check before commander parses — bypasses commander entirely but loses integration with `--help` display and short-flag aliasing.

### D3 — Place the `.version()` call before `.argument()` / `.option()` definitions

Commander recommends registering `.version()` early so it appears near the top of `--help` output, consistent with conventional CLI UX.

## Risks / Trade-offs

- [Risk] `createRequire` path is relative to the compiled/stripped file location → **Mitigation**: use `import.meta.url` as the base (the actual source file), which is stable under native type-stripping.
- [Risk] `plugin/` mirror gets stale if `core/` is committed without regenerating → **Mitigation**: `npm run ci` runs `build.mjs --check`; CI will catch it.
