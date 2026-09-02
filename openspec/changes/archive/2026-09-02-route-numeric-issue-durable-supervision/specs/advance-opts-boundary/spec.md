## MODIFIED Requirements

### Requirement: The advance run module SHALL NOT import the CLI module

`core/scripts/pipeline-run.ts` SHALL NOT import types or values from `./pipeline.ts` / `pipeline.ts`. The advance run module MAY import shared neutral modules, stage modules, and other non-CLI engine modules. The CLI module MAY import the advance run module and map fat CLI opts into the advance options bag at the internal executor call site. Public mutating `pipeline <N>` SHALL NOT call that executor as its top-level lifecycle owner. Nested whole-item advancement SHALL pass the mapped bag through the non-public adapter.

#### Scenario: Source-level cycle break

- **WHEN** `pipeline-run.ts` is inspected for imports
- **THEN** it SHALL contain no import (type-only or value) whose specifier resolves to `pipeline.ts`
- **AND** a unit/regression test SHALL fail if such an import is reintroduced

#### Scenario: CLI still drives advance via runAdvance

- **WHEN** the operator invokes mutating numeric advance (`pipeline <N>` / equivalent public entry)
- **THEN** the CLI SHALL enter the one-item durable supervisor rather than calling `runAdvance` as the top-level lifecycle owner
- **AND** nested whole-item advancement SHALL still call `runAdvance` with a mapped advance options bag
- **AND** stage transitions, labels, events, bundles, and auto-loop behavior for that nested child SHALL match the existing executor contract for the same logical option values
