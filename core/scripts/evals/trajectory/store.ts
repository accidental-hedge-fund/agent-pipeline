// Content-addressed writer for trajectory/verifier artifacts (#536,
// eval-trajectory-artifacts task 1.2). Every artifact is sanitized
// (secret-redaction + injection denylist, reusing artifact-sanitize.ts),
// hashed, and written under the experiment output directory keyed by that
// hash. Never rewrites an existing file: identical bytes at the same address
// are deduped (no write); differing bytes at the same address are surfaced as
// a collision rather than overwritten. Non-fatal: any I/O error is caught and
// reported as `{status:"error"}` rather than thrown, matching results.ts's
// appendCellRecord convention.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets, sanitize, sanitizeDeep } from "../../artifact-sanitize.ts";
import { TRAJECTORY_SCHEMA_VERSION, type ArtifactDescriptor, type TruncationStatus } from "./types.ts";

export interface ArtifactStoreDeps {
  mkdir?: (dir: string) => Promise<void>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  readFile?: (filePath: string) => Promise<string | null>;
}

async function defaultMkdir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}
async function defaultWriteFile(filePath: string, content: string): Promise<void> {
  await fs.promises.writeFile(filePath, content, "utf8");
}
async function defaultReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

export type ArtifactWriteResult =
  | { status: "written" | "deduped"; descriptor: ArtifactDescriptor }
  | { status: "collision"; error: string }
  | { status: "error"; error: string };

/** Content-address `payload` (an already-shaped trajectory or verifier
 *  evidence object) and write it under `absDir`, keyed by a hash of its
 *  sanitized bytes. `repoDir` is used only to compute the descriptor's
 *  repo-relative `path`. */
export async function writeContentAddressedArtifact(
  repoDir: string,
  absDir: string,
  payload: Record<string, unknown>,
  opts: { truncationStatus: TruncationStatus },
  deps: ArtifactStoreDeps = {},
): Promise<ArtifactWriteResult> {
  const mkdirFn = deps.mkdir ?? defaultMkdir;
  const writeFileFn = deps.writeFile ?? defaultWriteFile;
  const readFileFn = deps.readFile ?? defaultReadFile;
  try {
    const cleaned = sanitizeDeep(payload);
    const serialized = sanitize(redactSecrets(`${JSON.stringify(cleaned)}\n`));
    const hash = crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
    const absPath = path.join(absDir, `${hash}.json`);
    const relPath = path.relative(repoDir, absPath).split(path.sep).join("/");
    const descriptor: ArtifactDescriptor = {
      path: relPath,
      content_hash: hash,
      schema_version: TRAJECTORY_SCHEMA_VERSION,
      byte_count: Buffer.byteLength(serialized, "utf8"),
      truncation_status: opts.truncationStatus,
    };

    const existing = await readFileFn(absPath);
    if (existing !== null) {
      if (existing === serialized) {
        return { status: "deduped", descriptor };
      }
      return {
        status: "collision",
        error: `artifact content collision at ${relPath}: existing content differs from the newly-collected content addressed to the same hash`,
      };
    }
    await mkdirFn(absDir);
    await writeFileFn(absPath, serialized);
    return { status: "written", descriptor };
  } catch (err) {
    return { status: "error", error: (err as Error).message };
  }
}

/** Recompute a descriptor's `content_hash` over the bytes at its referenced
 *  path (resolved against `repoDir`) and report whether it verifies. */
export async function verifyArtifactHash(
  repoDir: string,
  descriptor: ArtifactDescriptor,
  deps: ArtifactStoreDeps = {},
): Promise<boolean> {
  const readFileFn = deps.readFile ?? defaultReadFile;
  const absPath = path.join(repoDir, descriptor.path);
  const content = await readFileFn(absPath);
  if (content === null) return false;
  const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  return hash === descriptor.content_hash;
}
