## Why

FRG is discovering orchestration defects by repeatedly creating remote fixture pairs because the matrix's “installed-CLI” layer is actually a direct registry lookup plus a generic simulator. Static filenames and generated test titles are currently accepted as coverage, so normal CI can report confidence that was never earned at the installed process boundary.

## What Changes

- Replace simulator-only installed-CLI credit with a deterministic qualification that launches the staged installed launcher and records typed per-cell results.
- Bind qualification artifacts to the exact candidate SHA and validate their completeness and integrity before lifecycle coverage is credited.
- Make normal CI execute this qualification and make FRG fail before remote fixture creation when candidate-bound qualification is absent or stale.
- Make remote FRG fixtures a final canary only: one candidate-bound pair, with persisted-artifact replay after failure instead of automatic pair replacement.
- Retain hermetic execution: no production credentials, GitHub mutations, model calls, or uncontrolled subprocesses.

## Capabilities

### New Capabilities

- `installed-cli-fault-qualification`: Defines the real installed-launcher execution boundary, deterministic fault cases, and candidate-bound evidence artifact.

### Modified Capabilities

- `universal-fault-recovery-matrix`: Installed-CLI coverage must come from executed launcher evidence rather than module/test-name declarations.
- `factory-reliability-gate`: Promotion must consume exact-candidate qualification before creating or accepting a remote canary pair, and failed canaries must reuse persisted artifacts.

## Impact

The change affects the installed launcher test fixture, fault-recovery matrix coverage binder, CI scripts, FRG prepare/promotion preflight, release evidence schemas, and release tests. It adds no provider routing change and performs no live GitHub writes during deterministic qualification.
