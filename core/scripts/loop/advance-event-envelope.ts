/** Canonical advance-event timestamps use whole seconds or exactly milliseconds in UTC. */
export function isCanonicalUtcEventTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = new Date(timestamp).toISOString();
  return value.includes(".") ? canonical === value : canonical.replace(".000Z", "Z") === value;
}
