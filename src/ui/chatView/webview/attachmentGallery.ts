import type { UiAttachment } from "../../messaging.js";

export interface AttachmentGallery {
  attachments: readonly UiAttachment[];
  index: number;
}

/** Keep navigation within the clicked message or draft, in attachment order. */
export function createAttachmentGallery(
  groups: readonly (readonly UiAttachment[])[],
  attachmentId: string
): AttachmentGallery | undefined {
  for (const attachments of groups) {
    const index = attachments.findIndex(attachment => attachment.id === attachmentId);
    if (index >= 0) return { attachments: [...attachments], index };
  }
  return undefined;
}

export function moveAttachmentGallery(gallery: AttachmentGallery, direction: -1 | 1): AttachmentGallery {
  if (gallery.attachments.length < 2) return gallery;
  return {
    ...gallery,
    index: (gallery.index + direction + gallery.attachments.length) % gallery.attachments.length
  };
}
