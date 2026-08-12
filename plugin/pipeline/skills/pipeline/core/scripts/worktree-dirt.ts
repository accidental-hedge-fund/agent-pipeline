// Product-vs-scratch classification for gate trust checks (#873 / #1013).
//
// Format and test gates require a worktree that is "clean enough" to trust:
// product-relevant uncommitted paths still hard-block, but engine-known
// non-product agent scratch (planning notes, ephemeral prompt drop files,
// challenge-response dumps) must not alone refuse the gate or burn recovery
// budget as test-gate-exhausted. Lockfiles are intentionally NOT classified
// as scratch — they remain handled by lockfile fold (#722 / #358).

/**
 * Engine-known non-product scratch patterns (always active; config may only
 * **extend** this set, never replace it).
 *
 * - `tasks/**` — planning notes left dirty by scoped authoring salvage
 *   (`allowDirtyPattern: /^tasks\//`, #321); includes `tasks/todo.md`.
 * - `.pipeline-prompt-*` at worktree root — ephemeral harness prompt files
 *   (e.g. grok adapter writes `.pipeline-prompt-<uuid>.txt`).
 * - `artifacts/challenge-response-*.json` — pipeline-owned design-gate /
 *   review challenge dumps left untracked under `artifacts/` (#1013). Narrow
 *   basename pattern only; the rest of `artifacts/**` remains product dirt.
 */
export const ENGINE_NON_PRODUCT_SCRATCH_GLOBS: readonly string[] = [
  "tasks/**",
  ".pipeline-prompt-*",
  "artifacts/challenge-response-*.json",
];

export interface DirtClassification {
  /** Paths that still fail gate trust (must be committed). */
  product: string[];
  /** Paths matching engine-known or config-extended non-product scratch. */
  scratch: string[];
}

/** Unquote a porcelain path segment (`"path with space"` → path with space). */
function unquotePorcelainPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse `git status --porcelain` into worktree-relative paths (status columns
 * stripped). Rename/copy records contribute **both** endpoints so a
 * product→scratch rename cannot drop the product half and evade the dirty
 * gate (#873 review 2). Pure — no I/O.
 */
export function parsePorcelainPaths(statusOutput: string): string[] {
  const paths: string[] = [];
  for (const line of statusOutput.split("\n")) {
    if (line.length < 3) continue;
    const rest = line.slice(3); // two-char status + space
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) {
      // Rename/copy: "old -> new" — keep both so either endpoint can be product.
      const src = unquotePorcelainPath(rest.slice(0, arrow));
      const dst = unquotePorcelainPath(rest.slice(arrow + 4));
      if (src) paths.push(src);
      if (dst) paths.push(dst);
    } else {
      const unquoted = unquotePorcelainPath(rest);
      if (unquoted) paths.push(unquoted);
    }
  }
  return paths;
}

/**
 * Classify porcelain paths into product dirt vs non-product scratch.
 * `extraGlobs` is **unioned** with the engine-known set (never replaces it).
 */
export function classifyWorktreeDirt(
  paths: readonly string[],
  extraGlobs: readonly string[] = [],
): DirtClassification {
  const product: string[] = [];
  const scratch: string[] = [];
  for (const p of paths) {
    if (isNonProductScratchPath(p, extraGlobs)) scratch.push(p);
    else product.push(p);
  }
  return { product, scratch };
}

/** Product paths only — empty means clean enough for gate trust. */
export function productDirtyPaths(
  paths: readonly string[],
  extraGlobs: readonly string[] = [],
): string[] {
  return classifyWorktreeDirt(paths, extraGlobs).product;
}

/**
 * Product namespace prefixes that extension globs must never waive. Paths under
 * these trees are always product dirt for gate trust (#873 review 2).
 */
export const PRODUCT_NAMESPACE_PREFIXES: readonly string[] = [
  "core/",
  "plugin/",
  "openspec/",
  "hosts/",
  "scripts/",
];

/** Recognized lockfile basenames — fold targets, never ignorable scratch. */
export const RECOGNIZED_LOCKFILE_BASENAMES: readonly string[] = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

/**
 * Product root files that extension globs must never waive. Distinct from
 * namespaces: exact repo-root product artifacts.
 */
export const PRODUCT_ROOT_FILES: readonly string[] = [
  "package.json",
  "README.md",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

/**
 * Product canary paths used to reject over-broad scratch extension globs.
 * Includes nested product files and lockfiles so targeted exemptions like
 * `package-lock.json` or `core/package.json` cannot slip past finite samples
 * (#873 review 2). Classify-time `isAlwaysProductPath` is the hard boundary.
 */
export const PRODUCT_PATH_CANARIES: readonly string[] = [
  "core/scripts/foo.ts",
  "core/package.json",
  "plugin/scripts/foo.ts",
  "plugin/SKILL.md",
  "openspec/changes/x/proposal.md",
  "openspec/specs/foo/spec.md",
  "package.json",
  "scripts/build.mjs",
  "hosts/claude/SKILL.md",
  "README.md",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "core/package-lock.json",
];

/**
 * True when a path is always product-relevant for gate trust: under a product
 * namespace, a recognized lockfile, or a known product root file. Extension
 * globs cannot reclassify these as scratch (fail-closed).
 */
export function isAlwaysProductPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized) return false;
  const base = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  if ((RECOGNIZED_LOCKFILE_BASENAMES as readonly string[]).includes(base)) {
    return true;
  }
  for (const prefix of PRODUCT_NAMESPACE_PREFIXES) {
    const ns = prefix.slice(0, -1);
    if (normalized === ns || normalized.startsWith(prefix)) return true;
  }
  if ((PRODUCT_ROOT_FILES as readonly string[]).includes(normalized)) {
    return true;
  }
  return false;
}

/**
 * True when a configured scratch extension glob is safe: it must not match
 * protected product namespaces, product root files, or recognized lockfiles.
 * Uses structural prefix checks plus canaries so targeted product exemptions
 * (e.g. `package-lock.json`, `core/package.json`) are rejected even when they
 * miss a single sample canary (#873 review 2).
 */
export function isSafeScratchExtensionGlob(pattern: string): boolean {
  let normalized = pattern.replace(/\\/g, "/").trim();
  if (!normalized) return false;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);

  // Repo-wide wildcards
  if (
    normalized === "**" ||
    normalized === "*" ||
    normalized === "**/*" ||
    normalized === "*/**"
  ) {
    return false;
  }

  // Structural: pattern targets a product namespace (core/**, plugin/SKILL.md, …)
  for (const prefix of PRODUCT_NAMESPACE_PREFIXES) {
    const ns = prefix.slice(0, -1);
    if (
      normalized === ns ||
      normalized === prefix ||
      normalized === `${ns}/**` ||
      normalized === `${ns}/*` ||
      normalized.startsWith(prefix) ||
      normalized.startsWith(`${ns}/**`) ||
      normalized.startsWith(`${ns}/*`)
    ) {
      return false;
    }
  }

  // Lockfile basenames as exact or trailing path segments (no wildcards in leaf)
  const lastSeg = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  if ((RECOGNIZED_LOCKFILE_BASENAMES as readonly string[]).includes(lastSeg)) {
    return false;
  }
  for (const lock of RECOGNIZED_LOCKFILE_BASENAMES) {
    if (matchScratchGlob(lock, normalized)) return false;
    if (matchScratchGlob(`nested/${lock}`, normalized)) return false;
  }

  // Product root files (exact or matched via broad globs)
  for (const root of PRODUCT_ROOT_FILES) {
    if (matchScratchGlob(root, normalized)) return false;
  }

  // Expanded canaries catch remaining broad patterns (**/*.ts, */*, …)
  for (const canary of PRODUCT_PATH_CANARIES) {
    if (matchScratchGlob(canary, normalized)) return false;
  }
  return true;
}

/**
 * True when `filePath` matches engine-known scratch or any **safe** config
 * extension glob. Lockfiles and product trees never match the engine set and
 * cannot be waived by extension globs (classify-time hard exclusion).
 * Unsafe extension globs are ignored (fail-closed).
 */
export function isNonProductScratchPath(
  filePath: string,
  extraGlobs: readonly string[] = [],
): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized) return false;
  for (const pattern of ENGINE_NON_PRODUCT_SCRATCH_GLOBS) {
    if (matchScratchGlob(normalized, pattern)) return true;
  }
  // Fail-closed trust boundary: protected product paths are never extension-scratch.
  if (isAlwaysProductPath(normalized)) return false;
  for (const pattern of extraGlobs) {
    if (typeof pattern !== "string" || !pattern.trim()) continue;
    const trimmed = pattern.trim();
    // Fail-closed: never let a misconfigured extension waive product dirt.
    if (!isSafeScratchExtensionGlob(trimmed)) continue;
    if (matchScratchGlob(normalized, trimmed)) return true;
  }
  return false;
}

/** Normalize a repo-relative path for matching (forward slashes, no leading ./). */
function normalizeRepoPath(filePath: string): string {
  let p = filePath.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  // Drop trailing slash except for root-ish empty
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * Minimal path glob matcher for gate-trust scratch patterns.
 * Supports `*`, `**`, trailing `/` (prefix), and exact paths. No brace expansion.
 */
export function matchScratchGlob(filePath: string, pattern: string): boolean {
  const path = normalizeRepoPath(filePath);
  let pat = pattern.replace(/\\/g, "/").trim();
  while (pat.startsWith("./")) pat = pat.slice(2);

  // Trailing slash → directory prefix
  if (pat.endsWith("/") && !pat.endsWith("**/")) {
    const prefix = pat.slice(0, -1);
    return path === prefix || path.startsWith(prefix + "/");
  }

  // Fast paths for the engine-known patterns
  if (pat === "tasks/**") {
    return path === "tasks" || path.startsWith("tasks/");
  }
  if (pat === ".pipeline-prompt-*") {
    // Worktree-root only: no directory separators
    if (path.includes("/")) return false;
    return matchSimpleStar(path, ".pipeline-prompt-*");
  }
  if (pat === "artifacts/challenge-response-*.json") {
    // Worktree-relative under artifacts/ only; single segment basename.
    // Nested paths (e.g. artifacts/nested/challenge-response-1.json) do not match.
    if (!path.startsWith("artifacts/")) return false;
    const rest = path.slice("artifacts/".length);
    if (rest.includes("/")) return false;
    return matchSimpleStar(rest, "challenge-response-*.json");
  }

  // General: convert glob to regex
  // ** matches across segments; * matches within one segment
  let i = 0;
  let re = "^";
  while (i < pat.length) {
    if (pat[i] === "*" && pat[i + 1] === "*") {
      // ** or **/
      if (pat[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
      continue;
    }
    if (pat[i] === "*") {
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (pat[i] === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    const ch = pat[i];
    if (/[.+^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
    i += 1;
  }
  re += "$";
  return new RegExp(re).test(path);
}

function matchSimpleStar(value: string, pattern: string): boolean {
  // pattern has a single * (no /)
  const parts = pattern.split("*");
  if (parts.length === 1) return value === pattern;
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "") {
      if (i === 0) continue; // leading *
      if (i === parts.length - 1) return true; // trailing *
      continue;
    }
    if (i === 0) {
      if (!value.startsWith(part)) return false;
      idx = part.length;
      continue;
    }
    if (i === parts.length - 1) {
      return value.endsWith(part) && value.length - part.length >= idx;
    }
    const found = value.indexOf(part, idx);
    if (found < 0) return false;
    idx = found + part.length;
  }
  return true;
}

/**
 * Build a porcelain-style disclosure listing for product paths only, so
 * block reasons name trust failures rather than ignored scratch.
 */
export function formatProductDirtDisclosure(
  productPaths: readonly string[],
  cap = 8000,
): string {
  if (productPaths.length === 0) return "";
  const body = productPaths.map((p) => ` M ${p}`).join("\n");
  if (body.length <= cap) return `\n\nUncommitted paths:\n${body}`;
  return `\n\nUncommitted paths:\n${body.slice(0, cap)}\n\n[…output truncated]`;
}
