/**
 * Typed-record validation with readable diagnostics (decision D2). Validation
 * never modifies or drops a file: every file yields a `RecordAnalysis`, and
 * problems become diagnostics.
 *
 * @module Validate
 */
import type { ParsedDocument } from "./Frontmatter.ts";
import type { BodyScan } from "./Markdown.ts";
import {
  type Diagnostic,
  type FieldKind,
  JOURNAL_PERIODS,
  PROJECT_STATUSES,
  type RecordAnalysis,
  TASK_STATUSES,
  type TaskFields,
  type TypeDefinition,
  isTaskStatus,
} from "./Model.ts";

const DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const asString = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return undefined;
};

const asStringList = (value: unknown): ReadonlyArray<string> | undefined => {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value as ReadonlyArray<string>;
  }
  return undefined;
};

const describeValue = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (value instanceof Date) return `date ${value.toISOString().slice(0, 10)}`;
  if (typeof value === "object") return "a mapping";
  return `${typeof value} \`${String(value)}\``;
};

interface FieldCheckResult {
  readonly diagnostic: Diagnostic | undefined;
}

const checkField = (field: string, kind: FieldKind, value: unknown): FieldCheckResult => {
  const error = (message: string): FieldCheckResult => ({
    diagnostic: { severity: "error", code: "invalid-field-value", message, field },
  });
  const ok: FieldCheckResult = { diagnostic: undefined };
  if (value === null || value === undefined) return ok;

  switch (kind) {
    case "string":
    case "record-ref":
      return asString(value) === undefined
        ? error(`Field \`${field}\` must be a string, got ${describeValue(value)}.`)
        : ok;
    case "number":
      return typeof value === "number"
        ? ok
        : error(`Field \`${field}\` must be a number, got ${describeValue(value)}.`);
    case "boolean":
      return typeof value === "boolean"
        ? ok
        : error(`Field \`${field}\` must be a boolean, got ${describeValue(value)}.`);
    case "date": {
      const text = asString(value);
      if (text === undefined) {
        return error(`Field \`${field}\` must be a date string, got ${describeValue(value)}.`);
      }
      return DATE_PATTERN.test(text)
        ? ok
        : error(
            `Field \`${field}\` must look like YYYY-MM-DD or an ISO datetime, got \`${text}\`.`,
          );
    }
    case "task-status": {
      const text = asString(value);
      return text !== undefined && isTaskStatus(text)
        ? ok
        : error(
            `Field \`${field}\` must be one of ${TASK_STATUSES.join(", ")}; got ${describeValue(value)}.`,
          );
    }
    case "project-status": {
      const text = asString(value);
      return text !== undefined && (PROJECT_STATUSES as ReadonlyArray<string>).includes(text)
        ? ok
        : error(
            `Field \`${field}\` must be one of ${PROJECT_STATUSES.join(", ")}; got ${describeValue(value)}.`,
          );
    }
    case "journal-period": {
      const text = asString(value);
      return text !== undefined && (JOURNAL_PERIODS as ReadonlyArray<string>).includes(text)
        ? ok
        : error(
            `Field \`${field}\` must be one of ${JOURNAL_PERIODS.join(", ")}; got ${describeValue(value)}.`,
          );
    }
    case "string-list":
    case "record-ref-list":
      return asStringList(value) === undefined
        ? error(`Field \`${field}\` must be a list of strings, got ${describeValue(value)}.`)
        : ok;
    case "collection-query":
      return typeof value === "object" && !Array.isArray(value)
        ? ok
        : error(`Field \`${field}\` must be a mapping of filters, got ${describeValue(value)}.`);
    case "unknown":
      return ok;
  }
};

const filenameStem = (path: string): string => {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/\.md$/i, "");
};

const extractTaskFields = (frontmatter: Readonly<Record<string, unknown>>): TaskFields => {
  const status = asString(frontmatter["status"]);
  return {
    status: status !== undefined && isTaskStatus(status) ? status : undefined,
    sequence: asString(frontmatter["sequence"]),
    priority: asString(frontmatter["priority"]),
    due: asString(frontmatter["due"]),
    completed: asString(frontmatter["completed"]),
    project: asString(frontmatter["project"]),
    parent: asString(frontmatter["parent"]),
    dependsOn: asStringList(frontmatter["depends_on"]) ?? [],
    assignees: asStringList(frontmatter["assignees"]) ?? [],
  };
};

/**
 * Analyzes one parsed Markdown file against the type registry. Pure; the
 * caller supplies the parse and body scan.
 */
export const analyzeRecord = (input: {
  readonly path: string;
  readonly parsed: ParsedDocument;
  readonly scan: BodyScan;
  readonly types: ReadonlyMap<string, TypeDefinition>;
}): RecordAnalysis => {
  const { path, parsed, scan, types } = input;
  const diagnostics: Array<Diagnostic> = [];
  const frontmatter = parsed.frontmatter?.data ?? {};
  const hasFrontmatter = parsed.frontmatter !== undefined;

  if (parsed.frontmatter !== undefined && parsed.frontmatter.parseError !== undefined) {
    diagnostics.push({
      severity: "error",
      code: "frontmatter-parse-error",
      message: parsed.frontmatter.parseError,
    });
  }

  const typeValue = frontmatter["type"];
  let type: string | undefined;
  if (typeValue !== undefined && typeValue !== null) {
    const text = asString(typeValue);
    if (text === undefined) {
      diagnostics.push({
        severity: "error",
        code: "invalid-field-value",
        message: `Field \`type\` must be a string, got ${describeValue(typeValue)}.`,
        field: "type",
      });
    } else {
      type = text;
    }
  }

  const definition = type === undefined ? undefined : types.get(type);

  // Title: frontmatter `title`, alias `name` (warning), first H1, filename stem.
  let title = asString(frontmatter["title"]);
  if (title === undefined && typeof frontmatter["name"] === "string") {
    title = frontmatter["name"];
    if (definition !== undefined) {
      diagnostics.push({
        severity: "warning",
        code: "title-from-name-alias",
        message: "Using frontmatter `name` as the record title; prefer `title`.",
        field: "name",
      });
    }
  }
  if (title === undefined) {
    title = scan.firstHeading ?? filenameStem(path);
    if (definition !== undefined) {
      diagnostics.push({
        severity: "warning",
        code: "missing-title",
        message: `No \`title\` in frontmatter; derived "${title}" from ${
          scan.firstHeading !== undefined ? "the first heading" : "the filename"
        }.`,
        field: "title",
      });
    }
  }

  const idValue = frontmatter["id"];
  let id: string | undefined;
  if (idValue !== undefined && idValue !== null) {
    const text = asString(idValue);
    if (text === undefined || text.trim() === "") {
      diagnostics.push({
        severity: "error",
        code: "invalid-field-value",
        message: `Field \`id\` must be a non-empty string, got ${describeValue(idValue)}.`,
        field: "id",
      });
    } else {
      id = text.trim();
    }
  } else if (definition !== undefined) {
    diagnostics.push({
      severity: "warning",
      code: "missing-id",
      message: "No stable `id`; the record is identified by its path until one is minted.",
      field: "id",
    });
  }

  if (definition !== undefined) {
    for (const required of definition.required) {
      const value = frontmatter[required];
      if (value === undefined || value === null || value === "") {
        diagnostics.push({
          severity: "error",
          code: "missing-required-field",
          message: `Record type \`${definition.key}\` requires frontmatter field \`${required}\`.`,
          field: required,
        });
      }
    }
    for (const [field, kind] of Object.entries(definition.fields)) {
      const result = checkField(field, kind, frontmatter[field]);
      if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
    }
    if (definition.key === "collection") {
      const hasQuery = frontmatter["query"] !== undefined && frontmatter["query"] !== null;
      const hasItems = frontmatter["items"] !== undefined && frontmatter["items"] !== null;
      if (!hasQuery && !hasItems) {
        diagnostics.push({
          severity: "error",
          code: "missing-required-field",
          message:
            "Record type `collection` requires `query` filters or an `items` list (or both).",
        });
      }
    }
  }

  // Filename-prefix drift (I-/O- projection, decision D4).
  if (definition?.key === "task") {
    const base = path.split("/").at(-1) ?? path;
    const status = asString(frontmatter["status"]);
    if (status !== undefined && isTaskStatus(status)) {
      const closed = status === "done" || status === "canceled";
      if ((base.startsWith("I-") && closed) || (base.startsWith("O-") && !closed)) {
        diagnostics.push({
          severity: "warning",
          code: "filename-status-drift",
          message: `Filename prefix \`${base.slice(0, 2)}\` disagrees with status \`${status}\`; the frontmatter wins.`,
        });
      }
    }
  }

  const frontmatterTags = asStringList(frontmatter["tags"]) ?? [];
  const tags = [...new Set([...frontmatterTags, ...scan.tags])];

  const recognizedType = definition !== undefined;
  const valid =
    recognizedType && diagnostics.every((diagnostic) => diagnostic.severity !== "error");

  return {
    path,
    type,
    recognizedType,
    valid,
    id,
    title,
    frontmatter,
    hasFrontmatter,
    tags,
    diagnostics,
    task: definition?.key === "task" ? extractTaskFields(frontmatter) : undefined,
  };
};

/** Mints a recommended id for a record: `<type>-<slug-of-title>` (decision D3). */
export const mintId = (type: string, title: string): string => {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug === "" ? type : `${type}-${slug}`;
};
