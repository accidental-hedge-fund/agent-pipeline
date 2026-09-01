# Logical operation identity is the reliability denominator

Reliability is measured per immutable Logical Operation admitted at a public command boundary, not per process, run ID, attempt, wave, retry, or issue closure. The identity survives restart, reattachment, autonomous retry, and reconciled side effects; a genuinely new external admission receives a new identity unless it presents a valid resume binding. This prevents retries from inflating success counts and lets release evidence distinguish autonomous recovery from manual reinvocation.
