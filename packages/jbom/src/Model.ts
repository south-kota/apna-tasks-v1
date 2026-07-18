/**
 * Core JBOM model: record types, the task status lifecycle, diagnostics, and
 * the type registry that drives validation.
 *
 * v1 decisions implemented here are recorded in
 * `Life/Apna Tasks/notes/01-jbom-engine/decisions.md` (pending ratification).
 *
 * @module Model
 */
import * as Schema from "effect/Schema";

// ── Task status lifecycle (decision D4) ────────────────────────

export const OPEN_TASK_STATUSES = ["todo", "doing", "waiting", "blocked"] as const;
export const CLOSED_TASK_STATUSES = ["done", "canceled"] as const;
export const TASK_STATUSES = [...OPEN_TASK_STATUSES, ...CLOSED_TASK_STATUSES] as const;

export const TaskStatus = Schema.Literals(TASK_STATUSES);
export type TaskStatus = typeof TaskStatus.Type;

export const isTaskStatus = (value: unknown): value is TaskStatus =>
  typeof value === "string" && (TASK_STATUSES as ReadonlyArray<string>).includes(value);

export const isClosedStatus = (status: TaskStatus): boolean =>
  (CLOSED_TASK_STATUSES as ReadonlyArray<string>).includes(status);

// ── Built-in record types (decisions D1/D2) ────────────────────

export const BUILTIN_RECORD_TYPES = ["task", "note", "project", "journal", "collection"] as const;
export type BuiltinRecordType = (typeof BUILTIN_RECORD_TYPES)[number];

/** Value kinds the field validator understands (subset of spec ch. 04). */
export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "task-status"
  | "project-status"
  | "journal-period"
  | "string-list"
  | "record-ref"
  | "record-ref-list"
  | "collection-query"
  | "unknown";

export interface TypeDefinition {
  readonly key: string;
  /** Frontmatter fields that must be present (beyond `type`; `title` is handled leniently). */
  readonly required: ReadonlyArray<string>;
  /** Known fields and their kinds. Fields not listed are preserved and indexed untyped. */
  readonly fields: Readonly<Record<string, FieldKind>>;
}

const COMMON_FIELDS: Record<string, FieldKind> = {
  id: "string",
  title: "string",
  name: "string",
  description: "string",
  tags: "string-list",
  created: "date",
  updated: "date",
};

export const BUILTIN_TYPE_DEFINITIONS: ReadonlyArray<TypeDefinition> = [
  {
    key: "task",
    required: ["status"],
    fields: {
      ...COMMON_FIELDS,
      status: "task-status",
      sequence: "string",
      priority: "string",
      due: "date",
      completed: "date",
      assignees: "string-list",
      project: "record-ref",
      parent: "record-ref",
      depends_on: "record-ref-list",
      references: "record-ref-list",
    },
  },
  {
    key: "project",
    required: ["status"],
    fields: { ...COMMON_FIELDS, status: "project-status" },
  },
  {
    key: "note",
    required: [],
    fields: { ...COMMON_FIELDS, project: "record-ref", status: "string" },
  },
  {
    key: "journal",
    required: ["date"],
    fields: { ...COMMON_FIELDS, date: "date", period: "journal-period" },
  },
  {
    key: "collection",
    required: [],
    fields: { ...COMMON_FIELDS, query: "collection-query", items: "record-ref-list" },
  },
];

export const PROJECT_STATUSES = ["idea", "active", "paused", "done", "archived"] as const;
export const JOURNAL_PERIODS = ["day", "week", "month"] as const;

// ── Diagnostics ────────────────────────────────────────────────

export const DiagnosticSeverity = Schema.Literals(["error", "warning"]);
export type DiagnosticSeverity = typeof DiagnosticSeverity.Type;

export const Diagnostic = Schema.Struct({
  severity: DiagnosticSeverity,
  /** Stable machine code, e.g. `missing-required-field`. */
  code: Schema.String,
  /** Human-readable, single-line message. */
  message: Schema.String,
  field: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
});
export type Diagnostic = typeof Diagnostic.Type;

// ── Validated record shape ─────────────────────────────────────

/**
 * The outcome of parsing + validating one Markdown file. Regardless of
 * validity, the original file is untouched; diagnostics describe problems.
 */
export interface RecordAnalysis {
  /** Vault-relative POSIX path. */
  readonly path: string;
  /** `type` frontmatter value, when present (recognized or not). */
  readonly type: string | undefined;
  /** True when `type` matches a registered type definition. */
  readonly recognizedType: boolean;
  /** True when the record satisfies its type's requirements with no error diagnostics. */
  readonly valid: boolean;
  /** Stable id, when declared. Identity falls back to `path` otherwise. */
  readonly id: string | undefined;
  /** Declared or derived title (frontmatter `title`/`name`, first H1, filename stem). */
  readonly title: string | undefined;
  /** Full frontmatter mapping, unknown fields included. Empty when none. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly hasFrontmatter: boolean;
  readonly tags: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  /** Task-specific projection, present when `type === "task"`. */
  readonly task: TaskFields | undefined;
}

export interface TaskFields {
  readonly status: TaskStatus | undefined;
  readonly sequence: string | undefined;
  readonly priority: string | undefined;
  readonly due: string | undefined;
  readonly completed: string | undefined;
  readonly project: string | undefined;
  readonly parent: string | undefined;
  readonly dependsOn: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
}

// ── Vault file events (watcher output) ─────────────────────────

export type VaultFileEventKind = "created" | "updated" | "removed";

export interface VaultFileEvent {
  readonly kind: VaultFileEventKind;
  /** Vault-relative POSIX path. */
  readonly path: string;
}
