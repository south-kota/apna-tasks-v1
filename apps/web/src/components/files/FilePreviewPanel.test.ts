import { describe, expect, it } from "vite-plus/test";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  isMarkdownPreviewFile,
  resolveMarkdownPreviewMode,
  setMarkdownTaskChecked,
  type MarkdownViewSelection,
} from "./filePreviewMode";

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("resolveMarkdownPreviewMode", () => {
  const noSelection: MarkdownViewSelection = { path: null, mode: "source", revealRequestId: null };
  const base = {
    isMarkdown: true,
    relativePath: "notes/today.md",
    selection: noSelection,
    defaultMode: "edit",
    revealLine: null,
    revealRequestId: 1,
  } as const;

  it("applies the sticky default mode to files without an explicit selection", () => {
    expect(resolveMarkdownPreviewMode(base)).toBe("edit");
    expect(resolveMarkdownPreviewMode({ ...base, defaultMode: "rendered" })).toBe("rendered");
    expect(resolveMarkdownPreviewMode({ ...base, defaultMode: "source" })).toBe("source");
  });

  it("always uses the source surface for non-markdown files", () => {
    expect(resolveMarkdownPreviewMode({ ...base, isMarkdown: false })).toBe("source");
    expect(resolveMarkdownPreviewMode({ ...base, relativePath: null })).toBe("source");
  });

  it("prefers an explicit selection for the current file over the default", () => {
    const selection: MarkdownViewSelection = {
      path: "notes/today.md",
      mode: "rendered",
      revealRequestId: 1,
    };
    expect(resolveMarkdownPreviewMode({ ...base, selection })).toBe("rendered");
    expect(
      resolveMarkdownPreviewMode({ ...base, selection: { ...selection, mode: "source" } }),
    ).toBe("source");
  });

  it("ignores selections made for a different file", () => {
    const selection: MarkdownViewSelection = {
      path: "notes/other.md",
      mode: "rendered",
      revealRequestId: 1,
    };
    expect(resolveMarkdownPreviewMode({ ...base, selection })).toBe("edit");
  });

  it("falls back to source while a line reveal is pending", () => {
    expect(resolveMarkdownPreviewMode({ ...base, revealLine: 12 })).toBe("source");
    const staleSelection: MarkdownViewSelection = {
      path: "notes/today.md",
      mode: "edit",
      revealRequestId: 1,
    };
    expect(
      resolveMarkdownPreviewMode({
        ...base,
        selection: staleSelection,
        revealLine: 12,
        revealRequestId: 2,
      }),
    ).toBe("source");
  });

  it("keeps a mode re-picked after the reveal fired", () => {
    const repicked: MarkdownViewSelection = {
      path: "notes/today.md",
      mode: "edit",
      revealRequestId: 2,
    };
    expect(
      resolveMarkdownPreviewMode({
        ...base,
        selection: repicked,
        revealLine: 12,
        revealRequestId: 2,
      }),
    ).toBe("edit");
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});
