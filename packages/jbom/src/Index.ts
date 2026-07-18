/**
 * Rebuildable SQLite index over a JBOM vault.
 *
 * The database is a derived artifact (spec ch. 07/09): deleting the file and
 * calling `rebuild` reproduces it exactly from the Markdown corpus, and that
 * is the canonical recovery path. Incremental updates (`applyEvents`) must
 * converge to the same state a full rebuild would produce — the test suite
 * asserts this by comparing stable dumps.
 *
 * Uses `node:sqlite` (no native dependencies; Node >= 22.16).
 *
 * @module Index
 */
import * as NodeSqlite from "node:sqlite";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { ResolvedConfig } from "./Config.ts";
import type { Diagnostic, TaskStatus, VaultFileEvent } from "./Model.ts";
import { CLOSED_TASK_STATUSES, OPEN_TASK_STATUSES } from "./Model.ts";
import { analyzeFile, listMarkdownFiles, type AnalyzedFile } from "./Scan.ts";

const SCHEMA_VERSION = "1";

export class JbomIndexError extends Schema.TaggedErrorClass<JbomIndexError>()("JbomIndexError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

// ── Row shapes ─────────────────────────────────────────────────

export interface IndexedFile {
  readonly path: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  readonly hasFrontmatter: boolean;
  readonly type: string | undefined;
  readonly recognizedType: boolean;
  readonly valid: boolean;
  readonly id: string | undefined;
  readonly title: string | undefined;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tags: ReadonlyArray<string>;
}

export interface IndexedTask extends IndexedFile {
  readonly status: TaskStatus | undefined;
  readonly sequence: string | undefined;
  readonly priority: string | undefined;
  readonly due: string | undefined;
  readonly completed: string | undefined;
  readonly project: string | undefined;
  readonly parent: string | undefined;
  readonly assignees: ReadonlyArray<string>;
  readonly dependsOn: ReadonlyArray<string>;
}

export interface IndexedLink {
  readonly sourcePath: string;
  readonly rawTarget: string;
  readonly kind: string;
  readonly line: number;
  readonly targetPath: string | undefined;
}

export interface IndexedTaskRef {
  readonly sourcePath: string;
  readonly line: number;
  readonly checked: boolean;
  readonly sequence: string | undefined;
  readonly statusToken: string | undefined;
  readonly rawTarget: string | undefined;
  readonly targetPath: string | undefined;
  /** True when the resolved target is a `task` record (spec ch. 10 core rule). */
  readonly isTaskReference: boolean;
}

export interface IndexedDiagnostic extends Diagnostic {
  readonly path: string;
}

export interface RecordFilter {
  readonly type?: string;
  readonly tag?: string;
  readonly pathPrefix?: string;
  readonly validOnly?: boolean;
}

export interface TaskFilter {
  readonly statuses?: ReadonlyArray<TaskStatus>;
  readonly open?: boolean;
  readonly project?: string;
  readonly dueOnOrBefore?: string;
  readonly pathPrefix?: string;
}

export interface IndexStats {
  readonly files: number;
  readonly typedRecords: number;
  readonly validRecords: number;
  readonly tasks: number;
  readonly openTasks: number;
  readonly links: number;
  readonly diagnostics: number;
  readonly errors: number;
}

// ── Service ────────────────────────────────────────────────────

export class JbomIndex extends Context.Service<
  JbomIndex,
  {
    /** Drops all indexed data and rebuilds from the Markdown corpus. */
    readonly rebuild: () => Effect.Effect<IndexStats, JbomIndexError>;
    /** Applies watcher events incrementally. Converges with `rebuild`. */
    readonly applyEvents: (
      events: ReadonlyArray<VaultFileEvent>,
    ) => Effect.Effect<void, JbomIndexError>;
    readonly getRecord: (path: string) => Effect.Effect<IndexedFile | undefined, JbomIndexError>;
    readonly listRecords: (
      filter?: RecordFilter,
    ) => Effect.Effect<Array<IndexedFile>, JbomIndexError>;
    readonly listTasks: (filter?: TaskFilter) => Effect.Effect<Array<IndexedTask>, JbomIndexError>;
    readonly linksFrom: (path: string) => Effect.Effect<Array<IndexedLink>, JbomIndexError>;
    readonly backlinksOf: (path: string) => Effect.Effect<Array<IndexedLink>, JbomIndexError>;
    readonly listTaskRefs: (filter?: {
      readonly sourcePath?: string;
      readonly targetPath?: string;
    }) => Effect.Effect<Array<IndexedTaskRef>, JbomIndexError>;
    readonly listDiagnostics: (filter?: {
      readonly severity?: "error" | "warning";
      readonly pathPrefix?: string;
    }) => Effect.Effect<Array<IndexedDiagnostic>, JbomIndexError>;
    readonly listTags: () => Effect.Effect<Array<{ tag: string; count: number }>, JbomIndexError>;
    readonly stats: () => Effect.Effect<IndexStats, JbomIndexError>;
    /**
     * Deterministic snapshot of all indexed data (row ids excluded, rows
     * sorted). Two indexes over identical vault content produce identical
     * dumps — used to verify rebuild losslessness.
     */
    readonly dump: () => Effect.Effect<string, JbomIndexError>;
  }
>()("@t3tools/jbom/JbomIndex") {
  static readonly layer = (options: {
    readonly vaultRoot: string;
    readonly config: ResolvedConfig;
    /** Defaults to `<vaultRoot>/<runtimeDir>/index.sqlite`. Use `:memory:` for tests. */
    readonly dbPath?: string | undefined;
  }): Layer.Layer<JbomIndex, JbomIndexError, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(JbomIndex, makeIndex(options));
}

// ── SQL schema ─────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  has_frontmatter INTEGER NOT NULL,
  record_type TEXT,
  recognized INTEGER NOT NULL,
  valid INTEGER NOT NULL,
  record_id TEXT,
  title TEXT,
  frontmatter_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_type ON files(record_type);
CREATE INDEX IF NOT EXISTS files_record_id ON files(record_id);
CREATE TABLE IF NOT EXISTS fields(
  path TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY(path, key)
);
CREATE INDEX IF NOT EXISTS fields_key ON fields(key);
CREATE TABLE IF NOT EXISTS tags(
  path TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY(path, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
CREATE TABLE IF NOT EXISTS links(
  rowid_pk INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  raw_target TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  target_path TEXT
);
CREATE INDEX IF NOT EXISTS links_source ON links(source_path);
CREATE INDEX IF NOT EXISTS links_target ON links(target_path);
CREATE TABLE IF NOT EXISTS tasks(
  path TEXT PRIMARY KEY,
  status TEXT,
  sequence TEXT,
  priority TEXT,
  due TEXT,
  completed TEXT,
  project TEXT,
  parent TEXT,
  assignees_json TEXT NOT NULL,
  depends_on_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS task_refs(
  rowid_pk INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  checked INTEGER NOT NULL,
  sequence TEXT,
  status_token TEXT,
  raw_target TEXT,
  link_kind TEXT,
  target_path TEXT
);
CREATE INDEX IF NOT EXISTS task_refs_source ON task_refs(source_path);
CREATE INDEX IF NOT EXISTS task_refs_target ON task_refs(target_path);
CREATE TABLE IF NOT EXISTS diagnostics(
  rowid_pk INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  field TEXT,
  line INTEGER
);
CREATE INDEX IF NOT EXISTS diagnostics_path ON diagnostics(path);
`;

const DATA_TABLES = ["files", "fields", "tags", "links", "tasks", "task_refs", "diagnostics"];

// ── Link resolution ────────────────────────────────────────────

const EXTERNAL_TARGET = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const normalizeSegments = (input: string): string | undefined => {
  const output: Array<string> = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (output.length === 0) return undefined;
      output.pop();
    } else {
      output.push(segment);
    }
  }
  return output.join("/");
};

const makeResolver = (paths: ReadonlySet<string>) => {
  const byStem = new Map<string, Array<string>>();
  for (const path of paths) {
    const base = path.split("/").at(-1)!.replace(/\.md$/i, "").toLowerCase();
    const bucket = byStem.get(base);
    if (bucket === undefined) byStem.set(base, [path]);
    else bucket.push(path);
  }
  return (sourcePath: string, rawTarget: string, kind: string): string | undefined => {
    if (rawTarget === "") return undefined;
    if (kind === "wiki" || kind === "embed-wiki") {
      const cleaned = rawTarget.replace(/\.md$/i, "");
      const direct = normalizeSegments(cleaned);
      if (direct !== undefined && paths.has(`${direct}.md`)) return `${direct}.md`;
      const candidates = byStem.get(cleaned.split("/").at(-1)!.toLowerCase());
      if (candidates !== undefined && candidates.length === 1) return candidates[0];
      return undefined;
    }
    // markdown / embed links
    if (EXTERNAL_TARGET.test(rawTarget)) return undefined;
    let decoded = rawTarget;
    try {
      decoded = decodeURIComponent(rawTarget);
    } catch {
      // keep raw when percent-decoding fails
    }
    decoded = decoded.split("#")[0]!.split("?")[0]!;
    if (decoded === "") return undefined;
    const sourceDir = sourcePath.includes("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
      : "";
    const combined = decoded.startsWith("/")
      ? decoded.slice(1)
      : sourceDir === ""
        ? decoded
        : `${sourceDir}/${decoded}`;
    const normalized = normalizeSegments(combined);
    if (normalized === undefined) return undefined;
    if (paths.has(normalized)) return normalized;
    if (!/\.md$/i.test(normalized) && paths.has(`${normalized}.md`)) return `${normalized}.md`;
    return undefined;
  };
};

// ── Implementation ─────────────────────────────────────────────

/** Builds a `JbomIndex` service instance. Requires a `Scope` (owns the DB handle). */
export const makeIndex = Effect.fn("JbomIndex.make")(function* (options: {
  readonly vaultRoot: string;
  readonly config: ResolvedConfig;
  readonly dbPath?: string | undefined;
}): Effect.fn.Return<
  JbomIndex["Service"],
  JbomIndexError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { vaultRoot, config } = options;
  const dbPath = options.dbPath ?? path.join(vaultRoot, config.runtimeDir, "index.sqlite");

  if (dbPath !== ":memory:") {
    yield* fs
      .makeDirectory(path.dirname(dbPath), { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));
  }

  const db = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(dbPath);
        database.exec("PRAGMA journal_mode = WAL;");
        database.exec("PRAGMA foreign_keys = ON;");
        return database;
      },
      catch: (cause) =>
        new JbomIndexError({
          operation: "open",
          message: `Cannot open index database at ${dbPath}: ${String(cause)}`,
        }),
    }),
    (database) => Effect.sync(() => database.close()),
  );

  const run = <A>(operation: string, body: () => A): Effect.Effect<A, JbomIndexError> =>
    Effect.try({
      try: body,
      catch: (cause) =>
        new JbomIndexError({
          operation,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

  // Schema init + version check.
  yield* run("init", () => {
    db.exec(SCHEMA_SQL);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (row !== undefined && row.value !== SCHEMA_VERSION) {
      for (const table of DATA_TABLES) db.exec(`DELETE FROM ${table};`);
      db.exec("DELETE FROM meta;");
    }
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(SCHEMA_VERSION);
  });

  const semaphore = yield* Semaphore.make(1);

  const deleteFileRows = (relativePath: string) => {
    db.prepare("DELETE FROM files WHERE path = ?").run(relativePath);
    db.prepare("DELETE FROM fields WHERE path = ?").run(relativePath);
    db.prepare("DELETE FROM tags WHERE path = ?").run(relativePath);
    db.prepare("DELETE FROM links WHERE source_path = ?").run(relativePath);
    db.prepare("DELETE FROM tasks WHERE path = ?").run(relativePath);
    db.prepare("DELETE FROM task_refs WHERE source_path = ?").run(relativePath);
    db.prepare("DELETE FROM diagnostics WHERE path = ?").run(relativePath);
  };

  const insertAnalyzed = (file: AnalyzedFile) => {
    const { analysis, scan } = file;
    db.prepare(
      `INSERT INTO files(path, mtime_ms, size_bytes, has_frontmatter, record_type, recognized, valid, record_id, title, frontmatter_json)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      analysis.path,
      file.mtimeMs,
      file.sizeBytes,
      analysis.hasFrontmatter ? 1 : 0,
      analysis.type ?? null,
      analysis.recognizedType ? 1 : 0,
      analysis.valid ? 1 : 0,
      analysis.id ?? null,
      analysis.title ?? null,
      JSON.stringify(analysis.frontmatter),
    );
    const insertField = db.prepare(
      "INSERT OR REPLACE INTO fields(path, key, value_json) VALUES(?, ?, ?)",
    );
    for (const [key, value] of Object.entries(analysis.frontmatter)) {
      insertField.run(analysis.path, key, JSON.stringify(value ?? null));
    }
    const insertTag = db.prepare("INSERT OR IGNORE INTO tags(path, tag) VALUES(?, ?)");
    for (const tag of analysis.tags) insertTag.run(analysis.path, tag);
    const insertLink = db.prepare(
      "INSERT INTO links(source_path, raw_target, kind, line, target_path) VALUES(?, ?, ?, ?, NULL)",
    );
    for (const link of scan.links) {
      insertLink.run(analysis.path, link.rawTarget, link.kind, link.line);
    }
    if (analysis.task !== undefined) {
      db.prepare(
        `INSERT INTO tasks(path, status, sequence, priority, due, completed, project, parent, assignees_json, depends_on_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        analysis.path,
        analysis.task.status ?? null,
        analysis.task.sequence ?? null,
        analysis.task.priority ?? null,
        analysis.task.due ?? null,
        analysis.task.completed ?? null,
        analysis.task.project ?? null,
        analysis.task.parent ?? null,
        JSON.stringify(analysis.task.assignees),
        JSON.stringify(analysis.task.dependsOn),
      );
    }
    const insertRef = db.prepare(
      `INSERT INTO task_refs(source_path, line, checked, sequence, status_token, raw_target, link_kind, target_path)
       VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const ref of scan.taskReferences) {
      insertRef.run(
        analysis.path,
        ref.line,
        ref.checked ? 1 : 0,
        ref.sequence ?? null,
        ref.statusToken ?? null,
        ref.link?.rawTarget ?? null,
        ref.link?.kind ?? null,
      );
    }
    const insertDiagnostic = db.prepare(
      "INSERT INTO diagnostics(path, severity, code, message, field, line) VALUES(?, ?, ?, ?, ?, ?)",
    );
    for (const diagnostic of analysis.diagnostics) {
      insertDiagnostic.run(
        analysis.path,
        diagnostic.severity,
        diagnostic.code,
        diagnostic.message,
        diagnostic.field ?? null,
        diagnostic.line ?? null,
      );
    }
  };

  /** Cross-file passes: link/task-ref resolution and duplicate-id detection. */
  const postBatch = () => {
    const paths = new Set<string>(
      (db.prepare("SELECT path FROM files").all() as Array<{ path: string }>).map(
        (row) => row.path,
      ),
    );
    const resolve = makeResolver(paths);

    const links = db
      .prepare("SELECT rowid_pk, source_path, raw_target, kind FROM links")
      .all() as Array<{ rowid_pk: number; source_path: string; raw_target: string; kind: string }>;
    const updateLink = db.prepare("UPDATE links SET target_path = ? WHERE rowid_pk = ?");
    for (const link of links) {
      updateLink.run(resolve(link.source_path, link.raw_target, link.kind) ?? null, link.rowid_pk);
    }

    const refs = db
      .prepare(
        "SELECT rowid_pk, source_path, raw_target, link_kind FROM task_refs WHERE raw_target IS NOT NULL",
      )
      .all() as Array<{
      rowid_pk: number;
      source_path: string;
      raw_target: string;
      link_kind: string;
    }>;
    const updateRef = db.prepare("UPDATE task_refs SET target_path = ? WHERE rowid_pk = ?");
    for (const ref of refs) {
      updateRef.run(resolve(ref.source_path, ref.raw_target, ref.link_kind) ?? null, ref.rowid_pk);
    }

    // Duplicate id detection: every file sharing the id gets an error
    // diagnostic. No arbitrary winner is picked and no file is destroyed or
    // demoted — resolving the ambiguity is a human/agent decision.
    db.prepare("DELETE FROM diagnostics WHERE code = 'duplicate-id'").run();
    const duplicates = db
      .prepare(
        `SELECT record_id, path FROM files
         WHERE record_id IS NOT NULL
           AND record_id IN (SELECT record_id FROM files WHERE record_id IS NOT NULL GROUP BY record_id HAVING COUNT(*) > 1)
         ORDER BY record_id, path`,
      )
      .all() as Array<{ record_id: string; path: string }>;
    const insertDiagnostic = db.prepare(
      "INSERT INTO diagnostics(path, severity, code, message, field, line) VALUES(?, 'error', 'duplicate-id', ?, 'id', NULL)",
    );
    for (const row of duplicates) {
      insertDiagnostic.run(
        row.path,
        `Duplicate id \`${row.record_id}\`; ids must be unique per vault.`,
      );
    }
  };

  const indexOne = Effect.fn("indexOne")(function* (relativePath: string) {
    const analyzed = yield* analyzeFile(vaultRoot, relativePath, config);
    yield* run("indexFile", () => {
      deleteFileRows(relativePath);
      if (analyzed !== undefined) insertAnalyzed(analyzed);
    });
  });

  const rebuild = Effect.fn("JbomIndex.rebuild")(function* () {
    const rebuiltAt = DateTime.formatIso(yield* DateTime.now);
    const files = yield* listMarkdownFiles(vaultRoot, config);
    const analyzed: Array<AnalyzedFile> = [];
    for (const file of files) {
      const result = yield* analyzeFile(vaultRoot, file, config);
      if (result !== undefined) analyzed.push(result);
    }
    yield* run("rebuild", () => {
      db.exec("BEGIN");
      try {
        for (const table of DATA_TABLES) db.exec(`DELETE FROM ${table};`);
        for (const file of analyzed) insertAnalyzed(file);
        postBatch();
        db.prepare(
          "INSERT INTO meta(key, value) VALUES('last_rebuild', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(rebuiltAt);
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    });
    return yield* statsEffect;
  });

  const applyEvents = Effect.fn("JbomIndex.applyEvents")(function* (
    events: ReadonlyArray<VaultFileEvent>,
  ) {
    if (events.length === 0) return;
    // Last event per path wins; created/updated are handled identically
    // (analyze the file as it exists now).
    const latest = new Map<string, VaultFileEvent>();
    for (const event of events) latest.set(event.path, event);

    yield* run("applyEvents:begin", () => db.exec("BEGIN"));
    const result = yield* Effect.gen(function* () {
      for (const event of latest.values()) {
        if (event.kind === "removed") {
          yield* run("applyEvents:remove", () => deleteFileRows(event.path));
        } else {
          yield* indexOne(event.path);
        }
      }
      yield* run("applyEvents:postBatch", () => postBatch());
    }).pipe(Effect.exit);
    if (result._tag === "Failure") {
      yield* run("applyEvents:rollback", () => db.exec("ROLLBACK")).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return yield* Effect.failCause(result.cause);
    }
    yield* run("applyEvents:commit", () => db.exec("COMMIT"));
  });

  // ── Row mapping ────────────────────────────────────────────

  interface FileRow {
    path: string;
    mtime_ms: number;
    size_bytes: number;
    has_frontmatter: number;
    record_type: string | null;
    recognized: number;
    valid: number;
    record_id: string | null;
    title: string | null;
    frontmatter_json: string;
  }

  const tagsFor = (relativePath: string): Array<string> =>
    (
      db.prepare("SELECT tag FROM tags WHERE path = ? ORDER BY tag").all(relativePath) as Array<{
        tag: string;
      }>
    ).map((row) => row.tag);

  const toIndexedFile = (row: FileRow): IndexedFile => ({
    path: row.path,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    hasFrontmatter: row.has_frontmatter === 1,
    type: row.record_type ?? undefined,
    recognizedType: row.recognized === 1,
    valid: row.valid === 1,
    id: row.record_id ?? undefined,
    title: row.title ?? undefined,
    frontmatter: JSON.parse(row.frontmatter_json) as Record<string, unknown>,
    tags: tagsFor(row.path),
  });

  const linkFromRow = (row: {
    source_path: string;
    raw_target: string;
    kind: string;
    line: number;
    target_path: string | null;
  }): IndexedLink => ({
    sourcePath: row.source_path,
    rawTarget: row.raw_target,
    kind: row.kind,
    line: row.line,
    targetPath: row.target_path ?? undefined,
  });

  const statsEffect = run("stats", (): IndexStats => {
    const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    return {
      files: count("SELECT COUNT(*) AS n FROM files"),
      typedRecords: count("SELECT COUNT(*) AS n FROM files WHERE recognized = 1"),
      validRecords: count("SELECT COUNT(*) AS n FROM files WHERE valid = 1"),
      tasks: count("SELECT COUNT(*) AS n FROM tasks"),
      openTasks: count(
        `SELECT COUNT(*) AS n FROM tasks WHERE status IN (${OPEN_TASK_STATUSES.map((status) => `'${status}'`).join(", ")})`,
      ),
      links: count("SELECT COUNT(*) AS n FROM links"),
      diagnostics: count("SELECT COUNT(*) AS n FROM diagnostics"),
      errors: count("SELECT COUNT(*) AS n FROM diagnostics WHERE severity = 'error'"),
    };
  });

  const withLock = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    semaphore.withPermits(1)(
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    );

  return JbomIndex.of({
    rebuild: () => withLock(rebuild()),
    applyEvents: (events) => withLock(applyEvents(events)),

    getRecord: (relativePath) =>
      withLock(
        run("getRecord", () => {
          const row = db.prepare("SELECT * FROM files WHERE path = ?").get(relativePath) as
            | FileRow
            | undefined;
          return row === undefined ? undefined : toIndexedFile(row);
        }),
      ),

    listRecords: (filter) =>
      withLock(
        run("listRecords", () => {
          const clauses: Array<string> = [];
          const params: Array<string> = [];
          if (filter?.type !== undefined) {
            clauses.push("record_type = ?");
            params.push(filter.type);
          }
          if (filter?.pathPrefix !== undefined) {
            clauses.push("path LIKE ?");
            params.push(`${filter.pathPrefix}%`);
          }
          if (filter?.validOnly === true) clauses.push("valid = 1");
          if (filter?.tag !== undefined) {
            clauses.push("path IN (SELECT path FROM tags WHERE tag = ?)");
            params.push(filter.tag);
          }
          const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
          const rows = db
            .prepare(`SELECT * FROM files${where} ORDER BY path`)
            .all(...params) as unknown as Array<FileRow>;
          return rows.map(toIndexedFile);
        }),
      ),

    listTasks: (filter) =>
      withLock(
        run("listTasks", () => {
          const clauses: Array<string> = [];
          const params: Array<string> = [];
          if (filter?.statuses !== undefined && filter.statuses.length > 0) {
            clauses.push(`t.status IN (${filter.statuses.map(() => "?").join(", ")})`);
            params.push(...filter.statuses);
          }
          if (filter?.open === true) {
            clauses.push(`t.status IN (${OPEN_TASK_STATUSES.map(() => "?").join(", ")})`);
            params.push(...OPEN_TASK_STATUSES);
          }
          if (filter?.open === false) {
            clauses.push(`t.status IN (${CLOSED_TASK_STATUSES.map(() => "?").join(", ")})`);
            params.push(...CLOSED_TASK_STATUSES);
          }
          if (filter?.project !== undefined) {
            clauses.push("t.project = ?");
            params.push(filter.project);
          }
          if (filter?.dueOnOrBefore !== undefined) {
            clauses.push("t.due IS NOT NULL AND t.due <= ?");
            params.push(filter.dueOnOrBefore);
          }
          if (filter?.pathPrefix !== undefined) {
            clauses.push("t.path LIKE ?");
            params.push(`${filter.pathPrefix}%`);
          }
          const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
          const rows = db
            .prepare(
              `SELECT f.*, t.status AS t_status, t.sequence AS t_sequence, t.priority AS t_priority,
                      t.due AS t_due, t.completed AS t_completed, t.project AS t_project,
                      t.parent AS t_parent, t.assignees_json, t.depends_on_json
               FROM tasks t JOIN files f ON f.path = t.path${where}
               ORDER BY t.sequence IS NULL, t.sequence, f.path`,
            )
            .all(...params) as unknown as Array<
            FileRow & {
              t_status: string | null;
              t_sequence: string | null;
              t_priority: string | null;
              t_due: string | null;
              t_completed: string | null;
              t_project: string | null;
              t_parent: string | null;
              assignees_json: string;
              depends_on_json: string;
            }
          >;
          return rows.map(
            (row): IndexedTask => ({
              ...toIndexedFile(row),
              status: (row.t_status ?? undefined) as TaskStatus | undefined,
              sequence: row.t_sequence ?? undefined,
              priority: row.t_priority ?? undefined,
              due: row.t_due ?? undefined,
              completed: row.t_completed ?? undefined,
              project: row.t_project ?? undefined,
              parent: row.t_parent ?? undefined,
              assignees: JSON.parse(row.assignees_json) as Array<string>,
              dependsOn: JSON.parse(row.depends_on_json) as Array<string>,
            }),
          );
        }),
      ),

    linksFrom: (relativePath) =>
      withLock(
        run("linksFrom", () =>
          (
            db
              .prepare(
                "SELECT source_path, raw_target, kind, line, target_path FROM links WHERE source_path = ? ORDER BY line",
              )
              .all(relativePath) as Array<{
              source_path: string;
              raw_target: string;
              kind: string;
              line: number;
              target_path: string | null;
            }>
          ).map(linkFromRow),
        ),
      ),

    backlinksOf: (relativePath) =>
      withLock(
        run("backlinksOf", () =>
          (
            db
              .prepare(
                "SELECT source_path, raw_target, kind, line, target_path FROM links WHERE target_path = ? ORDER BY source_path, line",
              )
              .all(relativePath) as Array<{
              source_path: string;
              raw_target: string;
              kind: string;
              line: number;
              target_path: string | null;
            }>
          ).map(linkFromRow),
        ),
      ),

    listTaskRefs: (filter) =>
      withLock(
        run("listTaskRefs", () => {
          const clauses: Array<string> = [];
          const params: Array<string> = [];
          if (filter?.sourcePath !== undefined) {
            clauses.push("r.source_path = ?");
            params.push(filter.sourcePath);
          }
          if (filter?.targetPath !== undefined) {
            clauses.push("r.target_path = ?");
            params.push(filter.targetPath);
          }
          const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
          const rows = db
            .prepare(
              `SELECT r.source_path, r.line, r.checked, r.sequence, r.status_token, r.raw_target, r.target_path,
                      COALESCE(f.record_type, '') AS target_type
               FROM task_refs r LEFT JOIN files f ON f.path = r.target_path${where}
               ORDER BY r.source_path, r.line`,
            )
            .all(...params) as Array<{
            source_path: string;
            line: number;
            checked: number;
            sequence: string | null;
            status_token: string | null;
            raw_target: string | null;
            target_path: string | null;
            target_type: string;
          }>;
          return rows.map(
            (row): IndexedTaskRef => ({
              sourcePath: row.source_path,
              line: row.line,
              checked: row.checked === 1,
              sequence: row.sequence ?? undefined,
              statusToken: row.status_token ?? undefined,
              rawTarget: row.raw_target ?? undefined,
              targetPath: row.target_path ?? undefined,
              isTaskReference: row.target_type === "task",
            }),
          );
        }),
      ),

    listDiagnostics: (filter) =>
      withLock(
        run("listDiagnostics", () => {
          const clauses: Array<string> = [];
          const params: Array<string> = [];
          if (filter?.severity !== undefined) {
            clauses.push("severity = ?");
            params.push(filter.severity);
          }
          if (filter?.pathPrefix !== undefined) {
            clauses.push("path LIKE ?");
            params.push(`${filter.pathPrefix}%`);
          }
          const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
          const rows = db
            .prepare(
              `SELECT path, severity, code, message, field, line FROM diagnostics${where} ORDER BY path, severity, code, message`,
            )
            .all(...params) as Array<{
            path: string;
            severity: "error" | "warning";
            code: string;
            message: string;
            field: string | null;
            line: number | null;
          }>;
          return rows.map(
            (row): IndexedDiagnostic => ({
              path: row.path,
              severity: row.severity,
              code: row.code,
              message: row.message,
              ...(row.field !== null ? { field: row.field } : {}),
              ...(row.line !== null ? { line: row.line } : {}),
            }),
          );
        }),
      ),

    listTags: () =>
      withLock(
        run(
          "listTags",
          () =>
            db
              .prepare("SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY tag")
              .all() as Array<{ tag: string; count: number }>,
        ),
      ),

    stats: () => withLock(statsEffect),

    dump: () =>
      withLock(
        run("dump", () => {
          const sections: Array<string> = [];
          const dumpQuery = (label: string, sql: string) => {
            const rows = db.prepare(sql).all();
            sections.push(`== ${label}\n${rows.map((row) => JSON.stringify(row)).join("\n")}`);
          };
          dumpQuery(
            "files",
            "SELECT path, size_bytes, has_frontmatter, record_type, recognized, valid, record_id, title, frontmatter_json FROM files ORDER BY path",
          );
          dumpQuery("fields", "SELECT path, key, value_json FROM fields ORDER BY path, key");
          dumpQuery("tags", "SELECT path, tag FROM tags ORDER BY path, tag");
          dumpQuery(
            "links",
            "SELECT source_path, raw_target, kind, line, target_path FROM links ORDER BY source_path, line, raw_target",
          );
          dumpQuery(
            "tasks",
            "SELECT path, status, sequence, priority, due, completed, project, parent, assignees_json, depends_on_json FROM tasks ORDER BY path",
          );
          dumpQuery(
            "task_refs",
            "SELECT source_path, line, checked, sequence, status_token, raw_target, link_kind, target_path FROM task_refs ORDER BY source_path, line",
          );
          dumpQuery(
            "diagnostics",
            "SELECT path, severity, code, message, field, line FROM diagnostics ORDER BY path, severity, code, message",
          );
          return sections.join("\n\n");
        }),
      ),
  });
});
