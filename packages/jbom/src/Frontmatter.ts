/**
 * Byte-preserving YAML frontmatter parsing and serialization for JBOM
 * Markdown records.
 *
 * The invariant this module guards: `serialize(parse(source)) === source` for
 * every input, byte for byte. Unknown frontmatter fields, YAML comments, key
 * order, CRLF line endings, and missing trailing newlines all survive an
 * untouched round-trip. Edits go through {@link updateFrontmatter}, which uses
 * the `yaml` document API so untouched keys and comments are preserved.
 *
 * @module Frontmatter
 */
import { parseDocument, stringify } from "yaml";

/** A parsed JBOM Markdown document. Holds enough to reproduce the source exactly. */
export interface ParsedDocument {
  /** The exact original text. */
  readonly source: string;
  /** The frontmatter block, when the file starts with a `---` fence. */
  readonly frontmatter: FrontmatterBlock | undefined;
  /** Exact text after the frontmatter block (the whole file when there is none). */
  readonly body: string;
}

export interface FrontmatterBlock {
  /** Exact bytes of the block: opening fence through closing fence + its newline. */
  readonly raw: string;
  /** The YAML text between the fences. */
  readonly yamlText: string;
  /** Parsed YAML mapping, or `undefined` when the YAML is invalid or not a mapping. */
  readonly data: Readonly<Record<string, unknown>> | undefined;
  /** Human-readable parse problem, when `data` is `undefined`. */
  readonly parseError: string | undefined;
  /** Number of lines the block occupies (for diagnostics line offsets). */
  readonly lineCount: number;
}

const OPEN_FENCE = /^---\r?\n/;
const CLOSE_FENCE = /^---[ \t]*$/;

const countLines = (text: string): number => text.split("\n").length - 1;

/**
 * Splits a Markdown source into its frontmatter block and body without losing
 * a single byte. A frontmatter block exists only when the file starts with a
 * `---` fence at byte 0 and a closing `---` line is found.
 */
export const parse = (source: string): ParsedDocument => {
  if (!OPEN_FENCE.test(source)) {
    return { source, frontmatter: undefined, body: source };
  }

  const firstNewline = source.indexOf("\n");
  const afterOpen = firstNewline + 1;
  const lines = source.slice(afterOpen).split("\n");
  let offset = afterOpen;
  for (const line of lines) {
    const content = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (CLOSE_FENCE.test(content)) {
      const yamlText = source.slice(afterOpen, offset);
      const closeEnd = offset + line.length;
      // Include the newline after the closing fence, when present.
      const rawEnd =
        closeEnd < source.length && source[closeEnd] === "\n" ? closeEnd + 1 : closeEnd;
      const raw = source.slice(0, rawEnd);
      return {
        source,
        frontmatter: { raw, yamlText, ...parseYamlMapping(yamlText), lineCount: countLines(raw) },
        body: source.slice(rawEnd),
      };
    }
    offset += line.length + 1;
  }

  // No closing fence: the whole file is body.
  return { source, frontmatter: undefined, body: source };
};

const parseYamlMapping = (
  yamlText: string,
): { data: Readonly<Record<string, unknown>> | undefined; parseError: string | undefined } => {
  const document = parseDocument(yamlText);
  if (document.errors.length > 0) {
    const first = document.errors[0]!;
    const line = first.linePos?.[0]?.line;
    const location = line === undefined ? "" : ` (line ${line})`;
    return {
      data: undefined,
      parseError: `Invalid YAML${location}: ${first.message.split("\n")[0]}`,
    };
  }
  const value = document.toJS() as unknown;
  if (value === null || value === undefined) {
    return { data: {}, parseError: undefined };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { data: undefined, parseError: "Frontmatter must be a YAML mapping." };
  }
  return { data: value as Readonly<Record<string, unknown>>, parseError: undefined };
};

/** Reassembles a parsed document. Identity for untouched documents. */
export const serialize = (parsed: ParsedDocument): string =>
  (parsed.frontmatter?.raw ?? "") + parsed.body;

/**
 * Returns new source text with the given frontmatter fields set (or deleted,
 * when the value is `undefined`). Untouched keys, YAML comments, key order,
 * body bytes, and the file's line-ending style are preserved. Creates a
 * frontmatter block when the file has none.
 */
export const updateFrontmatter = (
  source: string,
  updates: Readonly<Record<string, unknown>>,
): string => {
  const parsed = parse(source);

  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  );

  if (parsed.frontmatter === undefined) {
    if (Object.keys(definedUpdates).length === 0) return source;
    return `---\n${stringify(definedUpdates)}---\n${parsed.body}`;
  }

  const block = parsed.frontmatter;
  if (block.yamlText.trim() === "" || block.yamlText.trim() === "{}") {
    const eol = block.raw.includes("\r\n") ? "\r\n" : "\n";
    let yamlText = Object.keys(definedUpdates).length === 0 ? "" : stringify(definedUpdates);
    if (eol === "\r\n") yamlText = yamlText.replace(/\n/g, "\r\n");
    const closing = block.raw.endsWith("\n") ? `---${eol}` : "---";
    return `---${eol}${yamlText}${closing}${parsed.body}`;
  }

  const document = parseDocument(block.yamlText);
  if (document.errors.length > 0) {
    throw new Error(
      `Cannot update frontmatter with invalid YAML: ${document.errors[0]!.message.split("\n")[0]}`,
    );
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      document.delete(key);
    } else {
      document.set(key, value);
    }
  }

  const eol = block.raw.includes("\r\n") ? "\r\n" : "\n";
  let yamlText = document.toString();
  if (yamlText === "{}\n") yamlText = "";
  if (eol === "\r\n") yamlText = yamlText.replace(/\n/g, "\r\n");

  const closedWithNewline = block.raw.endsWith("\n");
  const closing = closedWithNewline ? `---${eol}` : "---";
  return `---${eol}${yamlText}${closing}${parsed.body}`;
};
