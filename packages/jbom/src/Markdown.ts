/**
 * Read-only Markdown body scanning for the JBOM index: links, tags, the
 * title-fallback H1, and task-reference lines (spec ch. 10).
 *
 * This is a line-oriented scanner, not a full Markdown AST. It is aware of
 * fenced code blocks and inline code spans so tags and links inside code are
 * not indexed. The body text is never modified.
 *
 * @module Markdown
 */

export type LinkKind = "markdown" | "wiki" | "embed";

export interface BodyLink {
  /** The raw target as written (`../tasks/foo.md`, `some-note#heading`, url). */
  readonly rawTarget: string;
  /** Link text or wiki alias, when present. */
  readonly text: string | undefined;
  readonly kind: LinkKind;
  /** 1-based line number within the scanned text. */
  readonly line: number;
}

/** A checkbox list item whose first link may reference a task record (spec ch. 10). */
export interface TaskReferenceCandidate {
  readonly line: number;
  readonly checked: boolean;
  /** Indentation width in characters (for nesting display). */
  readonly indent: number;
  /** Optional sequence token such as `01-02`. */
  readonly sequence: string | undefined;
  /** Optional displayed status token such as `doing`. */
  readonly statusToken: string | undefined;
  /** The first link on the line. Undefined for plain checklist items. */
  readonly link: BodyLink | undefined;
}

export interface BodyScan {
  /** Text of the first `# ` heading, for title fallback. */
  readonly firstHeading: string | undefined;
  readonly links: ReadonlyArray<BodyLink>;
  /** Inline `#tag` occurrences, deduplicated, without the leading `#`. */
  readonly tags: ReadonlyArray<string>;
  readonly taskReferences: ReadonlyArray<TaskReferenceCandidate>;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING_1 = /^#\s+(.*)$/;
const CHECKBOX = /^(\s*)[-*] \[( |x|X)\] (.*)$/;
const SEQUENCE_TOKEN = /^(\d{2}(?:-\d{2})*)\s+/;
const STATUS_TOKEN = /^(todo|doing|waiting|blocked|done|canceled)\s+/;
const WIKI_LINK = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const INLINE_CODE = /`[^`]*`/g;
const TAG = /(^|[\s(])#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g;

const stripInlineCode = (line: string): string =>
  line.replace(INLINE_CODE, (match) => " ".repeat(match.length));

const scanLineLinks = (line: string, lineNumber: number): Array<BodyLink> => {
  const links: Array<BodyLink> = [];
  for (const match of line.matchAll(WIKI_LINK)) {
    links.push({
      rawTarget: match[1]!.trim(),
      text: match[2]?.trim(),
      kind: match[0].startsWith("!") ? "embed" : "wiki",
      line: lineNumber,
    });
  }
  const withoutWiki = line.replace(WIKI_LINK, (match) => " ".repeat(match.length));
  for (const match of withoutWiki.matchAll(MARKDOWN_LINK)) {
    links.push({
      rawTarget: match[3]!,
      text: match[2] === "" ? undefined : match[2],
      kind: match[1] === "!" ? "embed" : "markdown",
      line: lineNumber,
    });
  }
  return links;
};

/**
 * Scans Markdown text. `lineOffset` shifts reported line numbers so callers
 * can pass a body extracted below a frontmatter block and still report
 * file-absolute lines.
 */
export const scanBody = (body: string, lineOffset = 0): BodyScan => {
  const lines = body.split(/\r?\n/);
  const links: Array<BodyLink> = [];
  const tags = new Set<string>();
  const taskReferences: Array<TaskReferenceCandidate> = [];
  let firstHeading: string | undefined;
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const lineNumber = lineOffset + i + 1;

    const fenceMatch = FENCE.exec(rawLine);
    if (fenceMatch !== undefined && fenceMatch !== null) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1]!;
      } else if (rawLine.trim().startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const line = stripInlineCode(rawLine);

    if (firstHeading === undefined) {
      const heading = HEADING_1.exec(line);
      if (heading) firstHeading = heading[1]!.trim();
    }

    for (const match of line.matchAll(TAG)) {
      tags.add(match[2]!.replace(/\/+$/, ""));
    }

    const lineLinks = scanLineLinks(line, lineNumber);
    links.push(...lineLinks);

    const checkbox = CHECKBOX.exec(line);
    if (checkbox) {
      let rest = checkbox[3]!;
      const sequenceMatch = SEQUENCE_TOKEN.exec(rest);
      const sequence = sequenceMatch?.[1];
      if (sequenceMatch) rest = rest.slice(sequenceMatch[0].length);
      const statusMatch = STATUS_TOKEN.exec(rest);
      const statusToken = statusMatch?.[1];
      taskReferences.push({
        line: lineNumber,
        checked: checkbox[2] !== " ",
        indent: checkbox[1]!.length,
        sequence,
        statusToken,
        link: lineLinks.find((candidate) => candidate.kind !== "embed"),
      });
    }
  }

  return { firstHeading, links, tags: [...tags], taskReferences };
};
