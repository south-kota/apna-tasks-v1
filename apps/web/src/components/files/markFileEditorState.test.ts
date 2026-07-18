import { describe, expect, it } from "vite-plus/test";

import {
  adoptExternalMarkEditorContents,
  initialMarkEditorDocumentState,
  markEditorDocumentId,
} from "./markFileEditorState";

describe("mark editor document state", () => {
  it("starts at revision zero with the mounted contents", () => {
    expect(initialMarkEditorDocumentState("# Hello\n")).toEqual({
      revision: 0,
      contents: "# Hello\n",
    });
  });

  it("keeps the same state when incoming contents match the mounted document", () => {
    const state = initialMarkEditorDocumentState("# Hello\n");
    expect(adoptExternalMarkEditorContents(state, "# Hello\n")).toBe(state);
  });

  it("bumps the revision when contents change externally", () => {
    const state = initialMarkEditorDocumentState("# Hello\n");
    const next = adoptExternalMarkEditorContents(state, "# Hello, Obsidian\n");
    expect(next).toEqual({ revision: 1, contents: "# Hello, Obsidian\n" });
    expect(adoptExternalMarkEditorContents(next, "# Third\n")).toEqual({
      revision: 2,
      contents: "# Third\n",
    });
  });

  it("derives distinct document ids per file, workspace, and revision", () => {
    const id = markEditorDocumentId("/vault", "notes/today.md", 0);
    expect(id).not.toBe(markEditorDocumentId("/vault", "notes/today.md", 1));
    expect(id).not.toBe(markEditorDocumentId("/vault", "notes/other.md", 0));
    expect(id).not.toBe(markEditorDocumentId("/other", "notes/today.md", 0));
    // Path segments must not be able to collide across the separator.
    expect(markEditorDocumentId("/vault/a", "b.md", 0)).not.toBe(
      markEditorDocumentId("/vault", "a/b.md", 0),
    );
  });
});
