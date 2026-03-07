import { describe, expect, it } from "bun:test";

import {
  appendTaskAttachmentsToPromptText,
  formatTaskAttachmentList,
} from "../prompt-attachments";

describe("prompt attachments", () => {
  const attachments = [
    {
      uploadId: "upload-1",
      kind: "image" as const,
      filename: "error-state.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      contentUrl: "https://example.test/uploads/upload-1/content?token=abc",
    },
  ];

  it("formats attachments as a dedicated image section", () => {
    const result = formatTaskAttachmentList(attachments);

    expect(result).toContain("## ATTACHED IMAGES");
    expect(result).toContain("error-state.png");
    expect(result).toContain(
      "![error-state.png](https://example.test/uploads/upload-1/content?token=abc)",
    );
  });

  it("appends attachments after the original prompt body", () => {
    const result = appendTaskAttachmentsToPromptText("Investigate the UI regression.", attachments);

    expect(result).toContain("Investigate the UI regression.");
    expect(result).toContain("## ATTACHED IMAGES");
    expect(result.indexOf("Investigate the UI regression.")).toBeLessThan(
      result.indexOf("## ATTACHED IMAGES"),
    );
  });
});
