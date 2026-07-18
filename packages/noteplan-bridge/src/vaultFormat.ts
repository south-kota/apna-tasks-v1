/**
 * Vault-side (Obsidian-readable) markdown conventions.
 *
 * The vault is plain markdown with YAML frontmatter. Obsidian needs no
 * adapter — it reads the vault folder directly.
 *
 * `VaultTask` is a deliberately minimal interface: Workstream 1's
 * `packages/jbom` will supply the real record API later. All knowledge of the
 * vault task-line syntax is confined to this module so swapping the codec for
 * JBOM records is a contained change.
 *
 * Default vault task-line syntax (Obsidian Tasks plugin compatible):
 *
 *     - [ ] water the plants 📅 2026-07-18
 *     - [x] file taxes 📅 2026-04-01 ✅ 2026-03-30
 *     - [-] cancelled thing
 */
import * as Yaml from "yaml";

export type VaultTaskStatus = "open" | "done" | "cancelled";

export interface VaultTask {
  readonly indent: string;
  readonly status: VaultTaskStatus;
  readonly title: string;
  /** Due date as `YYYY-MM-DD`, if the task is dated. */
  readonly due: string | undefined;
  /** Completion date as `YYYY-MM-DD`, if recorded. */
  readonly doneDate: string | undefined;
}

const TASK_LINE_RE = /^(\s*)- \[([ x-])\] (.*)$/;
const DUE_TOKEN_RE = /(?:^|\s)📅 ?(\d{4}-\d{2}-\d{2})(?=\s|$)/u;
const DONE_TOKEN_RE = /(?:^|\s)✅ ?(\d{4}-\d{2}-\d{2})(?=\s|$)/u;

const STATUS_BY_CHAR: Record<string, VaultTaskStatus> = {
  " ": "open",
  x: "done",
  "-": "cancelled",
};

const CHAR_BY_STATUS: Record<VaultTaskStatus, string> = {
  open: " ",
  done: "x",
  cancelled: "-",
};

export function parseVaultTaskLine(line: string): VaultTask | null {
  const match = TASK_LINE_RE.exec(line);
  if (match === null) {
    return null;
  }
  const indent = match[1] ?? "";
  const status = STATUS_BY_CHAR[match[2] ?? " "] ?? "open";
  let rest = match[3] ?? "";

  let due: string | undefined;
  const dueMatch = DUE_TOKEN_RE.exec(rest);
  if (dueMatch !== null) {
    due = dueMatch[1];
    rest = rest.replace(DUE_TOKEN_RE, " ");
  }

  let doneDate: string | undefined;
  const doneMatch = DONE_TOKEN_RE.exec(rest);
  if (doneMatch !== null) {
    doneDate = doneMatch[1];
    rest = rest.replace(DONE_TOKEN_RE, " ");
  }

  return {
    indent,
    status,
    title: rest.replace(/\s+/g, " ").trim(),
    due,
    doneDate,
  };
}

export function renderVaultTaskLine(task: VaultTask): string {
  let line = `${task.indent}- [${CHAR_BY_STATUS[task.status]}] ${task.title}`;
  if (task.due !== undefined) {
    line += ` 📅 ${task.due}`;
  }
  if (task.doneDate !== undefined) {
    line += ` ✅ ${task.doneDate}`;
  }
  return line;
}

export interface FrontmatterSplit {
  /** Raw frontmatter block including both `---` fences, or null when absent. */
  readonly frontmatter: string | null;
  readonly body: string;
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Split a markdown document into its YAML frontmatter block (verbatim) and body. */
export function splitFrontmatter(content: string): FrontmatterSplit {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) {
    return { frontmatter: null, body: content };
  }
  return { frontmatter: match[0], body: content.slice(match[0].length) };
}

export function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter === null) {
    return body;
  }
  const fence = frontmatter.endsWith("\n") ? frontmatter : `${frontmatter}\n`;
  return `${fence}${body}`;
}

/** Render a minimal frontmatter block from key/value pairs. */
export function renderFrontmatter(fields: Record<string, unknown>): string {
  return `---\n${Yaml.stringify(fields)}---\n`;
}
