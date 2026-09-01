export interface WorkspaceFileLink {
  path: string;
  tooltip: string;
  line?: number;
}

/** Return only the final file-name segment for either slash convention. */
export function workspaceFileName(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(separator + 1) || filePath;
}

/**
 * Resolve a Markdown link destination as a workspace file reference.
 * The extension host still applies assertInsideWorkspace before opening it.
 */
export function resolveWorkspaceFileLink(
  href: string,
  workspaceRoot?: string
): WorkspaceFileLink | undefined {
  let candidate = decodeHref(href.trim());
  if (!candidate || candidate.startsWith("#")) return undefined;

  let line: number | undefined;
  const hashLine = candidate.match(/#L(\d+)(?:C\d+)?$/i);
  if (hashLine) {
    line = Number(hashLine[1]);
    candidate = candidate.slice(0, hashLine.index);
  } else {
    const lineSuffix = candidate.match(/:(\d+)(?::\d+)?$/);
    if (lineSuffix) {
      line = Number(lineSuffix[1]);
      candidate = candidate.slice(0, lineSuffix.index);
    }
  }

  if (/^file:/i.test(candidate)) {
    candidate = fileUriPath(candidate);
    if (!candidate) return undefined;
  } else if (!isWindowsAbsolute(candidate) && /^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    return undefined;
  }

  candidate = candidate.split(/[?#]/, 1)[0].trim();
  if (!candidate) return undefined;

  const normalizedCandidate = normalizeSlashes(candidate);
  const normalizedRoot = workspaceRoot ? normalizeSlashes(workspaceRoot).replace(/\/$/, "") : "";
  if (isAbsolute(normalizedCandidate)) {
    if (!normalizedRoot || !isInside(normalizedRoot, normalizedCandidate)) return undefined;
    const path = platformPath(normalizedCandidate, workspaceRoot!);
    return { path, tooltip: path, line };
  }

  const relative = normalizeRelative(normalizedCandidate);
  if (!relative) return undefined;
  const path = platformPath(relative, workspaceRoot);
  const tooltip = normalizedRoot
    ? platformPath(`${normalizedRoot}/${relative}`, workspaceRoot!)
    : path;
  return { path, tooltip, line };
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function fileUriPath(href: string): string {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:") return "";
    let pathname = decodeHref(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    if (url.hostname && url.hostname.toLowerCase() !== "localhost") {
      pathname = `//${url.hostname}${pathname}`;
    }
    return pathname;
  } catch {
    return "";
  }
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function isAbsolute(value: string): boolean {
  return isWindowsAbsolute(value) || value.startsWith("/");
}

function normalizeSlashes(value: string): string {
  const slashed = value.replace(/\\/g, "/");
  const unc = slashed.startsWith("//");
  const normalized = slashed.replace(/\/{2,}/g, "/");
  return unc ? `/${normalized}` : normalized;
}

function normalizeRelative(value: string): string | undefined {
  const output: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (output.length === 0) return undefined;
      output.pop();
      continue;
    }
    output.push(segment);
  }
  return output.length > 0 ? output.join("/") : undefined;
}

function isInside(root: string, candidate: string): boolean {
  const windows = isWindowsAbsolute(root);
  const normalizedRoot = windows ? root.toLowerCase() : root;
  const normalizedCandidate = windows ? candidate.toLowerCase() : candidate;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function platformPath(value: string, workspaceRoot?: string): string {
  return workspaceRoot?.includes("\\") ? value.replace(/\//g, "\\") : value;
}
