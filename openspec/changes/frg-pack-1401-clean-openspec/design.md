## Context

See `proposal.md` for motivation. This synthetic path needs one static JSON
fixture and one hermetic test. Existing tests already use `node:fs`,
`JSON.parse`, and `node:test` for this shape.

## Goals / Non-Goals

**Goals:**

- Keep all fixture identity in the pack-run directory.
- Use the smallest existing disk-read test pattern.

**Non-Goals:**

- Production modules, a fixture framework, or FRG scoring changes.

## Decisions

Use a static JSON object and a colocated `node:test` assertion resolved from
`import.meta.url`. This reuses the established standard-library pattern and
avoids a new loader or schema. A production import was rejected because this
test exercises the fixture contract, not engine behavior.

## Risks / Trade-offs

- [The archived capability is specific to one pack run] → This is intentional;
  the FRG closes the synthetic PR without merge after observing the archive.
- [A later pack copies the layout] → Each pack receives a distinct run-scoped
  directory and test.
