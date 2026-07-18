/**
 * Pure parsing and serialization for NotePlan's on-disk conventions.
 *
 * Verified against the real store on this machine
 * (`~/Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp/`):
 *
 * - Daily notes: `Calendar/YYYYMMDD.md` (weekly `YYYY-Wnn.md` and monthly
 *   `YYYY-MM.md` also exist — the bridge treats those as unmapped).
 * - Task lines: `- [ ]` / `* [ ]` style checkboxes with states ` `, `x`
 *   (done), `-` (cancelled), `>` (forwarded). Plain `* task` bullets are also
 *   tasks in NotePlan when the "asterisk is todo" preference is on; this
 *   parser only treats explicit checkbox lines as tasks so plain bullets
 *   round-trip untouched.
 * - Scheduling token `>YYYY-MM-DD` (renders the task on that calendar day),
 *   completion stamp `@done(YYYY-MM-DD HH:MM)`.
 */

export type NotePlanTaskState = "open" | "done" | "cancelled" | "forwarded";

export interface NotePlanTask {
  readonly indent: string;
  readonly marker: "-" | "*" | "+";
  readonly state: NotePlanTaskState;
  /** Task text with schedule / done tokens removed and whitespace collapsed at the edges. */
  readonly text: string;
  /** `>YYYY-MM-DD` schedule target, if present. */
  readonly scheduled: string | undefined;
  /** Raw contents of a `@done(...)` stamp, if present. */
  readonly doneStamp: string | undefined;
}

const CALENDAR_DAILY_RE = /^(\d{4})(\d{2})(\d{2})\.md$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TASK_LINE_RE = /^(\s*)([-*+]) \[([ x\->])\] (.*)$/;
const SCHEDULE_TOKEN_RE = /(?:^|\s)>(\d{4}-\d{2}-\d{2})(?=\s|$)/;
const DONE_TOKEN_RE = /(?:^|\s)@done\(([^)]*)\)(?=\s|$)/;

const STATE_BY_CHAR: Record<string, NotePlanTaskState> = {
  " ": "open",
  x: "done",
  "-": "cancelled",
  ">": "forwarded",
};

const CHAR_BY_STATE: Record<NotePlanTaskState, string> = {
  open: " ",
  done: "x",
  cancelled: "-",
  forwarded: ">",
};

/** `2026-07-18` -> `20260718.md` */
export function calendarFileNameFromIsoDate(isoDate: string): string | null {
  const match = ISO_DATE_RE.exec(isoDate);
  if (match === null) {
    return null;
  }
  return `${match[1]}${match[2]}${match[3]}.md`;
}

/** `20260718.md` -> `2026-07-18`; `2026-W08.md` / `2026-07.md` -> null (unmapped). */
export function isoDateFromCalendarFileName(fileName: string): string | null {
  const match = CALENDAR_DAILY_RE.exec(fileName);
  if (match === null) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function parseNotePlanTaskLine(line: string): NotePlanTask | null {
  const match = TASK_LINE_RE.exec(line);
  if (match === null) {
    return null;
  }
  const indent = match[1] ?? "";
  const marker = match[2] as NotePlanTask["marker"];
  const state = STATE_BY_CHAR[match[3] ?? " "] ?? "open";
  let rest = match[4] ?? "";

  let scheduled: string | undefined;
  const scheduleMatch = SCHEDULE_TOKEN_RE.exec(rest);
  if (scheduleMatch !== null) {
    scheduled = scheduleMatch[1];
    rest = rest.replace(SCHEDULE_TOKEN_RE, " ");
  }

  let doneStamp: string | undefined;
  const doneMatch = DONE_TOKEN_RE.exec(rest);
  if (doneMatch !== null) {
    doneStamp = doneMatch[1];
    rest = rest.replace(DONE_TOKEN_RE, " ");
  }

  return {
    indent,
    marker,
    state,
    text: rest.replace(/\s+/g, " ").trim(),
    scheduled,
    doneStamp,
  };
}

export function renderNotePlanTaskLine(task: NotePlanTask): string {
  let line = `${task.indent}${task.marker} [${CHAR_BY_STATE[task.state]}] ${task.text}`;
  if (task.scheduled !== undefined) {
    line += ` >${task.scheduled}`;
  }
  if (task.doneStamp !== undefined) {
    line += ` @done(${task.doneStamp})`;
  }
  return line;
}
