// Packaging coherence gate (#627): keep root vs core package.json version and
// Node engines floors honest. Pure read of package.json objects — no network,
// git, or subprocess mutation. Invoked from packaging-coherence.test.mjs under
// ci:scripts / npm run ci.

/**
 * Lowest major admitted by a simple engines.node range used in this repo.
 * Recognizes `>=N` / `>=N.x.y` (optionally with trailing spaces). Returns null
 * when the range cannot be interpreted as a floor (e.g. `*`, empty, multi-clause).
 *
 * @param {unknown} range
 * @returns {number | null}
 */
export function parseEnginesFloorMajor(range) {
  if (typeof range !== "string") return null;
  const trimmed = range.trim();
  // Only accept a single lower-bound form that cannot admit majors below N.
  // Multi-clause ranges (||), upper bounds only, or wildcards are unparseable
  // for this gate and treated as incoherent.
  const m = /^>=\s*(\d+)(?:\.\d+)*\s*$/.exec(trimmed);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

/**
 * Compare root and core package metadata.
 *
 * @param {{ version?: unknown, engines?: { node?: unknown } }} rootPkg
 * @param {{ version?: unknown, engines?: { node?: unknown } }} corePkg
 * @returns {{ ok: true } | { ok: false, failures: string[] }}
 */
export function checkPackagingCoherence(rootPkg, corePkg) {
  const failures = [];

  const rootVersion = rootPkg?.version;
  const coreVersion = corePkg?.version;
  if (typeof rootVersion !== "string" || typeof coreVersion !== "string") {
    failures.push(
      `version fields must be strings (root=${JSON.stringify(rootVersion)}, core=${JSON.stringify(coreVersion)})`,
    );
  } else if (rootVersion !== coreVersion) {
    failures.push(
      `root package.json version (${rootVersion}) differs from core/package.json version (${coreVersion})`,
    );
  }

  const rootEngines = rootPkg?.engines?.node;
  const coreEngines = corePkg?.engines?.node;
  const coreFloor = parseEnginesFloorMajor(coreEngines);
  const rootFloor = parseEnginesFloorMajor(rootEngines);

  if (coreFloor === null) {
    failures.push(
      `core engines.node is unparseable or not a simple >=N floor: ${JSON.stringify(coreEngines)}`,
    );
  }
  if (rootFloor === null) {
    failures.push(
      `root engines.node is unparseable or not a simple >=N floor: ${JSON.stringify(rootEngines)}`,
    );
  }
  if (coreFloor !== null && rootFloor !== null && rootFloor < coreFloor) {
    failures.push(
      `root engines.node (${JSON.stringify(rootEngines)}) admits Node major ${rootFloor}, ` +
        `below core floor ${coreFloor} (${JSON.stringify(coreEngines)})`,
    );
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}
