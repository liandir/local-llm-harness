import { describe, expect, it } from "vitest";
import type { UiAttachment } from "../src/ui/messaging.js";
import { createAttachmentGallery, moveAttachmentGallery } from "../src/ui/chatView/webview/attachmentGallery.js";

function attachment(id: string, mimeType: UiAttachment["mimeType"] = "image/png"): UiAttachment {
  const extension = mimeType === "text/plain" ? "txt" : "png";
  return { id, fileName: `${id}.${extension}`, mimeType, extension, byteLength: 20, previewUri: `attachment:${id}` };
}

describe("attachment preview gallery", () => {
  it("starts at the clicked attachment and stays within its message or draft", () => {
    const draft = [attachment("draft")];
    const queued = [attachment("queued")];
    const message = [attachment("first"), attachment("notes", "text/plain"), attachment("last")];
    const otherMessage = [attachment("other")];
    const groups = [draft, queued, message, otherMessage];

    for (const group of groups) {
      const gallery = createAttachmentGallery(groups, group.at(-1)!.id)!;
      expect(gallery.attachments).toEqual(group);
      expect(gallery.attachments[gallery.index]).toEqual(group.at(-1));
      const next = moveAttachmentGallery(gallery, 1);
      expect(next.attachments[next.index]).toEqual(group[0]);
    }
  });

  it("cycles images and text files in order in both directions, wrapping at the ends", () => {
    const files = [attachment("first"), attachment("notes", "text/plain"), attachment("last")];
    let gallery = createAttachmentGallery([files], "first")!;
    const visited: string[] = [];
    for (const step of [1, 1, 1, -1, -1, -1] as const) {
      gallery = moveAttachmentGallery(gallery, step);
      visited.push(gallery.attachments[gallery.index].id);
    }
    expect(visited).toEqual(["notes", "last", "first", "last", "notes", "first"]);
  });

  it("includes queued attachments beyond the first three thumbnail slots", () => {
    const files = Array.from({ length: 5 }, (_, index) => attachment(String(index)));
    const gallery = moveAttachmentGallery(createAttachmentGallery([files], "2")!, 1);
    expect(gallery.attachments[gallery.index]).toEqual(files[3]);
    const next = moveAttachmentGallery(gallery, 1);
    expect(next.attachments[next.index]).toEqual(files[4]);
  });

  it("keeps a single attachment selected when stepping in either direction", () => {
    const gallery = createAttachmentGallery([[attachment("only", "text/plain")]], "only")!;
    expect(moveAttachmentGallery(gallery, 1).index).toBe(0);
    expect(moveAttachmentGallery(gallery, -1).index).toBe(0);
  });

  it("does not open an empty group or an attachment that is no longer present", () => {
    expect(createAttachmentGallery([], "missing")).toBeUndefined();
    expect(createAttachmentGallery([[], [attachment("current")]], "missing")).toBeUndefined();
  });

  it("keeps the open gallery stable when the source attachment list changes", () => {
    const files = [attachment("first"), attachment("second")];
    const gallery = createAttachmentGallery([files], "second")!;
    files.splice(0, files.length, attachment("replacement"));
    expect(gallery.attachments[gallery.index].id).toBe("second");
    const next = moveAttachmentGallery(gallery, 1);
    expect(next.attachments[next.index].id).toBe("first");
  });
});
