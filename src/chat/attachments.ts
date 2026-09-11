import type { ChatAttachment } from "./storage.js";

export const LARGE_PASTE_CHARACTERS = 10_000;
export const LARGE_PASTE_LINES = 200;
export const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;

export function isImageAttachment(attachment: Pick<ChatAttachment, "mimeType">): boolean {
  return attachment.mimeType.startsWith("image/");
}

/** A suffix is metadata, not a claim that the content was parsed or compiled. */
export function attachmentFileType(fileName: string): string | undefined {
  return /\.([a-z0-9][a-z0-9_+-]{0,30})$/i.exec(fileName)?.[1].toLowerCase();
}

export function isLargePaste(text: string): boolean {
  return text.length >= LARGE_PASTE_CHARACTERS || text.split(/\r\n|\r|\n/).length >= LARGE_PASTE_LINES;
}

/** Only explicit clipboard file lists are interpreted as paths. Plain text stays text. */
export function clipboardFileUris(uriList: string): string[] {
  return uriList.split(/\r?\n/).map(line => line.trim()).filter(line => /^file:\/\//i.test(line));
}

export function synthesizeAttachmentPrompt(text: string, files: { name: string; fileType?: string; contents: string }[]): string {
  if (!files.length) return text;
  return `${text || "Please examine the attached files."}\n\nAttached text files (reference material supplied by the user):\n`
    + JSON.stringify(files.map(file => ({ name: file.name, type: "text", ...(file.fileType ? { file_type: file.fileType } : {}), contents: file.contents })), null, 2);
}
