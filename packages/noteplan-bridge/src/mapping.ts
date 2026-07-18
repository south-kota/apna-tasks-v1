/**
 * Pure document transforms between vault markdown and NotePlan markdown.
 *
 * Design rules (see notes/04-noteplan-bridge/notes.md):
 *
 * - NotePlan-side documents never carry YAML frontmatter; the vault side owns
 *   frontmatter and it is preserved verbatim across round trips.
 * - Task lines are translated token-for-token; non-task lines pass through
 *   unchanged, so prose and plain bullets are never rewritten.
 * - In a daily note, a vault due date equal to the note's own date is
 *   redundant in NotePlan (the task already lives on that day) and is
 *   dropped; any other due date becomes a `>YYYY-MM-DD` schedule token so
 *   NotePlan renders the task on that calendar day.
 * - Both transforms are deterministic and idempotent: mapping a document that
 *   is already in target form is a no-op, which is what makes the hash ledger
 *   loop protection sound.
 */
import {
  parseNotePlanTaskLine,
  renderNotePlanTaskLine,
  type NotePlanTask,
} from "./notePlanFormat.ts";
import {
  joinFrontmatter,
  parseVaultTaskLine,
  renderFrontmatter,
  renderVaultTaskLine,
  splitFrontmatter,
  type VaultTask,
} from "./vaultFormat.ts";

function vaultTaskToNotePlan(task: VaultTask, noteDate: string | null): NotePlanTask {
  const scheduled = task.due !== undefined && task.due !== noteDate ? task.due : undefined;
  return {
    indent: task.indent,
    marker: "-",
    state: task.status,
    text: task.title,
    scheduled,
    doneStamp: task.doneDate,
  };
}

function notePlanTaskToVault(task: NotePlanTask): VaultTask {
  const doneDate = task.doneStamp?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  return {
    indent: task.indent,
    // NotePlan's "forwarded" state has no vault equivalent yet; treat it as open.
    status: task.state === "done" ? "done" : task.state === "cancelled" ? "cancelled" : "open",
    title: task.text,
    due: task.scheduled,
    doneDate,
  };
}

function mapLines(content: string, mapLine: (line: string) => string): string {
  return content.split("\n").map(mapLine).join("\n");
}

/**
 * Vault document -> NotePlan document. `noteDate` is the ISO date for daily
 * notes (due dates equal to it are dropped) and null for project notes.
 */
export function vaultToNotePlan(content: string, noteDate: string | null): string {
  const { body } = splitFrontmatter(content);
  return mapLines(body, (line) => {
    const task = parseVaultTaskLine(line);
    if (task === null) {
      return line;
    }
    return renderNotePlanTaskLine(vaultTaskToNotePlan(task, noteDate));
  });
}

/**
 * NotePlan document -> vault document. Frontmatter from the previous vault
 * copy is preserved verbatim; a new daily note gets a minimal `date:` block.
 */
export function notePlanToVault(
  content: string,
  options: {
    readonly noteDate: string | null;
    readonly previousVaultContent: string | null;
  },
): string {
  const body = mapLines(content, (line) => {
    const task = parseNotePlanTaskLine(line);
    if (task === null) {
      return line;
    }
    return renderVaultTaskLine(notePlanTaskToVault(task));
  });

  let frontmatter: string | null = null;
  if (options.previousVaultContent !== null) {
    frontmatter = splitFrontmatter(options.previousVaultContent).frontmatter;
  } else if (options.noteDate !== null) {
    frontmatter = renderFrontmatter({ type: "daily", date: options.noteDate });
  }
  return joinFrontmatter(frontmatter, body);
}
