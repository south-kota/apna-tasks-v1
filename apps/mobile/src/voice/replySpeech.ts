/**
 * Turn an agent reply (markdown) into something worth hearing.
 *
 * Code blocks, tables, links, and markdown syntax read terribly out loud, so
 * they are stripped or reduced to their text content, and long replies are
 * capped at a sentence boundary.
 */

export interface TrimReplyOptions {
  /** Maximum spoken length in characters. Defaults to 900 (~60s of speech). */
  readonly maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 900;

export function trimReplyForSpeech(markdown: string, options?: TrimReplyOptions): string {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;

  let text = markdown;

  // Fenced code blocks (``` or ~~~, with optional info string) are dropped
  // entirely: hearing code character-by-character is useless.
  text = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "");
  // Unterminated fence: drop from the fence to the end.
  text = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/gm, "");

  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine;

    // Table rows and separators.
    if (/^\s*\|/.test(line)) continue;
    // Horizontal rules.
    if (/^\s*([-*_]\s*){3,}$/.test(line)) continue;

    // Headings, blockquotes, list markers.
    line = line.replace(/^\s*#{1,6}\s+/, "");
    line = line.replace(/^\s*(>\s*)+/, "");
    line = line.replace(/^\s*([-*+]|\d{1,3}[.)])\s+/, "");
    // Task-list checkboxes.
    line = line.replace(/^\s*\[[ xX]\]\s+/, "");

    lines.push(line);
  }
  text = lines.join("\n");

  // Images -> alt text, links -> link text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Autolinks and bare URLs.
  text = text.replace(/<https?:\/\/[^>]+>/g, "link");
  text = text.replace(/https?:\/\/\S+/g, "link");

  // Inline code: keep the content, drop the backticks.
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/`/g, "");

  // Emphasis markers. Underscores are left alone (snake_case identifiers).
  text = text.replace(/\*\*|__|~~/g, "");
  text = text.replace(/\*/g, "");

  // Collapse whitespace.
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(". ")
    .replace(/[.!?:;,]\.\s/g, (match) => `${match[0]} `)
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (text.length <= maxLength) return text;

  // Cap at a sentence boundary when one exists reasonably far in; otherwise
  // fall back to a word boundary.
  const slice = text.slice(0, maxLength);
  const sentenceEnd = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  if (sentenceEnd > maxLength * 0.4) {
    return slice.slice(0, sentenceEnd + 1);
  }
  const wordEnd = slice.lastIndexOf(" ");
  return `${slice.slice(0, wordEnd > 0 ? wordEnd : maxLength).trimEnd()}…`;
}
