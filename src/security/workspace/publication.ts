import * as fs from "node:fs/promises";

/**
 * Remove the temporary name after hardlink-based no-clobber publication.
 * The first unlink is the normal fast path. If it fails, the caller performs
 * an identity-checked retry so an already committed target is not stranded as
 * a multiply linked, unusable file.
 */
export async function cleanupPublishedTemporary(
  temporaryAbsolute: string,
  guardedRetry: () => Promise<void>,
  unlink: ((path: string) => Promise<void>) | undefined = fs.unlink
): Promise<void> {
  try {
    await (unlink ?? fs.unlink)(temporaryAbsolute);
  } catch {
    await guardedRetry();
  }
}
