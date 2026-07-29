// Pure lock-ownership helpers for harness-side discovery of a live loop
// supervisor (#668 pre-merge finding: unanchored PID grep can attach to the
// wrong run; "child of LOOP_PID" must be a real parent-chain walk, not a
// substring match).

/**
 * Parse the numeric `pid` field from a loop `lock.json` document.
 * Accepts a JSON number or a whole-digit string. Rejects floats, empty,
 * non-positive, and non-integer values. Does not treat "123" as a prefix of
 * "12345" — the entire field value must be exactly one integer.
 */
export function parseLockPid(lockJsonText: string): number | null {
  let obj: unknown;
  try {
    obj = JSON.parse(lockJsonText);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const raw = (obj as { pid?: unknown }).pid;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw <= 0) return null;
    return raw;
  }
  if (typeof raw === "string") {
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }
  return null;
}

/**
 * True when `lockPid` is the launcher, or a descendant of the launcher
 * (walk parents of `lockPid` via `parentOf` until match, root, or cycle).
 *
 * Uses **numeric** identity only — never string prefix equality
 * (`123` must not match lock pid `12345`).
 *
 * @param parentOf - returns the parent pid of `pid`, or null/undefined when
 *   unknown / at process tree root. Injected so unit tests need no /proc.
 */
export function isLockPidOwnedByLauncher(
  lockPid: number,
  launcherPid: number,
  parentOf: (pid: number) => number | null | undefined,
): boolean {
  if (!Number.isInteger(lockPid) || !Number.isInteger(launcherPid)) return false;
  if (lockPid <= 0 || launcherPid <= 0) return false;

  let cur: number | null = lockPid;
  const seen = new Set<number>();
  while (cur != null && cur > 0) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    if (cur === launcherPid) return true;
    const parent = parentOf(cur);
    if (parent == null || !Number.isInteger(parent) || parent <= 0) return false;
    if (parent === cur) return false;
    cur = parent;
  }
  return false;
}
