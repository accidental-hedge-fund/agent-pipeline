# Background-job lifecycle protocol fixtures (#1299)

Recorded raw-protocol evidence used to pin `background_job_lifecycle`
support vs non-support. **Transcript wording is not proof.** An adapter
whose protocol cannot emit job identity, start, complete/fail, notification
delivery, and foreground-join stays `supported: false`.

| Fixture | Provenance | Support |
| --- | --- | --- |
| `claude-547.json` | Historical Claude `#547` hang | unsupported |
| `incident-268.json` | lyric-utils `#268` implementing hang | unsupported |
