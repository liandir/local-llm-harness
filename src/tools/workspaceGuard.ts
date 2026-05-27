import * as path from "node:path";
import * as fs from "node:fs/promises";

export class WorkspaceGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGuardError";
  }
}

/**
 * Resolves `requested` against `workspaceRoot` and returns the absolute path
 * IFF it is contained inside the workspace. Defeats `..` traversal AND
 * symlinks-pointing-outside by using realpath on the deepest existing ancestor.
 *
 * Throws WorkspaceGuardError otherwise.
 */
export async function assertInsideWorkspace(
  workspaceRoot: string,
  requested: string
): Promise<string> {
  if (!workspaceRoot) {
    throw new WorkspaceGuardError("No workspace folder is open.");
  }
  const rootReal = await fs.realpath(workspaceRoot);
  const joined = path.isAbsolute(requested)
    ? requested
    : path.join(rootReal, requested);
  const normalized = path.normalize(joined);

  // Resolve the deepest ancestor that actually exists, then re-append the rest.
  // This catches: symlink-to-/etc, .. traversal, /etc/passwd absolute paths.
  const real = await realpathOfDeepestExisting(normalized);
  const withSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (real !== rootReal && !real.startsWith(withSep)) {
    throw new WorkspaceGuardError(
      `Path ${requested} resolves to ${real} which is outside the workspace ${rootReal}.`
    );
  }
  return real;
}

async function realpathOfDeepestExisting(p: string): Promise<string> {
  const parts = p.split(path.sep);
  let i = parts.length;
  while (i > 0) {
    const candidate = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      const real = await fs.realpath(candidate);
      const tail = parts.slice(i).join(path.sep);
      return tail ? path.normalize(path.join(real, tail)) : real;
    } catch {
      i--;
    }
  }
  return p;
}
