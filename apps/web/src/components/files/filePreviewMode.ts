export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

/**
 * How the preview panel presents a markdown file:
 * - "source": the plain-text code editor (upstream default surface)
 * - "rendered": read-mostly rendered markdown (upstream eye toggle)
 * - "edit": Mark's CodeMirror live-preview editor (Apna Tasks addition)
 */
export type MarkdownPreviewMode = "source" | "rendered" | "edit";

export const MARKDOWN_PREVIEW_MODES = ["source", "rendered", "edit"] as const;

export const isMarkdownPreviewMode = (value: unknown): value is MarkdownPreviewMode =>
  MARKDOWN_PREVIEW_MODES.includes(value as MarkdownPreviewMode);

export interface MarkdownViewSelection {
  /** File the user explicitly picked a mode for, or null when untouched. */
  readonly path: string | null;
  readonly mode: MarkdownPreviewMode;
  /** Reveal request active when the selection was made (see resolver below). */
  readonly revealRequestId: number | null;
}

export interface ResolveMarkdownPreviewModeOptions {
  readonly isMarkdown: boolean;
  readonly relativePath: string | null;
  readonly selection: MarkdownViewSelection;
  /** Sticky default applied to files without an explicit selection. */
  readonly defaultMode: MarkdownPreviewMode;
  readonly revealLine: number | null;
  readonly revealRequestId: number;
}

/**
 * Resolves which surface a file gets. Non-markdown files are always "source".
 * A pending line-reveal request (file:line links) forces "source" — line
 * anchors only exist in the code surface — unless the user re-picked a mode
 * after the reveal fired (tracked via revealRequestId, matching the upstream
 * rendered-markdown behavior).
 */
export function resolveMarkdownPreviewMode({
  isMarkdown,
  relativePath,
  selection,
  defaultMode,
  revealLine,
  revealRequestId,
}: ResolveMarkdownPreviewModeOptions): MarkdownPreviewMode {
  if (!isMarkdown || relativePath === null) return "source";
  const selected = selection.path === relativePath ? selection : null;
  const mode = selected?.mode ?? defaultMode;
  if (mode === "source") return "source";
  if (revealLine !== null && selected?.revealRequestId !== revealRequestId) return "source";
  return mode;
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
