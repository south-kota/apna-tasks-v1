/**
 * `jbom.json` runtime configuration (decision D6). A vault with no config
 * file works entirely on defaults; the file only overrides them.
 *
 * @module Config
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import { BUILTIN_TYPE_DEFINITIONS, type FieldKind, type TypeDefinition } from "./Model.ts";

// ── Schema ─────────────────────────────────────────────────────

const FieldKindSchema = Schema.Literals([
  "string",
  "number",
  "boolean",
  "date",
  "task-status",
  "project-status",
  "journal-period",
  "string-list",
  "record-ref",
  "record-ref-list",
  "collection-query",
  "unknown",
]);

export const CustomTypeConfig = Schema.Struct({
  required: Schema.optional(Schema.Array(Schema.String)),
  optional: Schema.optional(Schema.Array(Schema.String)),
  fields: Schema.optional(Schema.Record(Schema.String, FieldKindSchema)),
});
export type CustomTypeConfig = typeof CustomTypeConfig.Type;

export const JbomConfig = Schema.Struct({
  version: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  contentRoots: Schema.optional(Schema.Array(Schema.String)),
  ignore: Schema.optional(Schema.Array(Schema.String)),
  types: Schema.optional(Schema.Record(Schema.String, CustomTypeConfig)),
  tasks: Schema.optional(
    Schema.Struct({
      filenamePrefixes: Schema.optional(Schema.Boolean),
    }),
  ),
  runtimeDir: Schema.optional(Schema.String),
});
export type JbomConfig = typeof JbomConfig.Type;

export class JbomConfigError extends Schema.TaggedErrorClass<JbomConfigError>()("JbomConfigError", {
  path: Schema.String,
  message: Schema.String,
}) {}

// ── Resolved config ────────────────────────────────────────────

export interface ResolvedConfig {
  readonly name: string | undefined;
  readonly contentRoots: ReadonlyArray<string>;
  /** Extra ignore globs from config, additive to {@link DEFAULT_IGNORES}. */
  readonly ignore: ReadonlyArray<string>;
  readonly runtimeDir: string;
  readonly taskFilenamePrefixes: boolean;
  /** Built-in + custom type definitions, keyed by type name. */
  readonly types: ReadonlyMap<string, TypeDefinition>;
}

/**
 * Directory or file names ignored anywhere in the tree. Any path segment
 * starting with `.` is additionally ignored (covers `.git`, `.obsidian`,
 * `.jbom`, `.trash`, ...).
 */
export const DEFAULT_IGNORES: ReadonlyArray<string> = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
];

const buildRegistry = (
  custom: Readonly<Record<string, CustomTypeConfig>> | undefined,
): ReadonlyMap<string, TypeDefinition> => {
  const registry = new Map<string, TypeDefinition>();
  for (const definition of BUILTIN_TYPE_DEFINITIONS) {
    registry.set(definition.key, definition);
  }
  for (const [key, config] of Object.entries(custom ?? {})) {
    const base = registry.get(key);
    const fields: Record<string, FieldKind> = { ...base?.fields };
    for (const name of config.optional ?? []) {
      fields[name] ??= "unknown";
    }
    for (const name of config.required ?? []) {
      fields[name] ??= "unknown";
    }
    for (const [name, kind] of Object.entries(config.fields ?? {})) {
      fields[name] = kind;
    }
    registry.set(key, {
      key,
      required: config.required ?? base?.required ?? [],
      fields,
    });
  }
  return registry;
};

export const resolveConfig = (config: JbomConfig): ResolvedConfig => ({
  name: config.name,
  contentRoots:
    config.contentRoots === undefined || config.contentRoots.length === 0
      ? ["."]
      : config.contentRoots,
  ignore: config.ignore ?? [],
  runtimeDir: config.runtimeDir ?? ".jbom",
  taskFilenamePrefixes: config.tasks?.filenamePrefixes ?? false,
  types: buildRegistry(config.types),
});

export const defaultConfig: ResolvedConfig = resolveConfig({});

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(JbomConfig));

/** Loads `jbom.json` from the vault root, falling back to defaults when absent. */
export const loadConfig = Effect.fn("loadConfig")(function* (
  vaultRoot: string,
): Effect.fn.Return<ResolvedConfig, JbomConfigError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const configPath = `${vaultRoot}/jbom.json`;
  const exists = yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return defaultConfig;

  const contents = yield* fs.readFileString(configPath).pipe(
    Effect.mapError(
      (error) =>
        new JbomConfigError({
          path: configPath,
          message: `Cannot read jbom.json: ${error.message}`,
        }),
    ),
  );
  const config = yield* decodeConfig(contents).pipe(
    Effect.mapError(
      (error) =>
        new JbomConfigError({
          path: configPath,
          message: `Invalid jbom.json: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
        }),
    ),
  );
  return resolveConfig(config);
});

// ── Ignore matching ────────────────────────────────────────────

const globToRegExp = (glob: string): RegExp => {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        pattern += "(?:.*)";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}(?:/.*)?$`);
};

/**
 * Returns a predicate deciding whether a vault-relative POSIX path is ignored.
 * Default rules: ignored segment names ({@link DEFAULT_IGNORES}) and any
 * dot-prefixed segment; config globs are matched against the full path.
 */
export const makeIgnoreMatcher = (
  configIgnore: ReadonlyArray<string>,
): ((relativePath: string) => boolean) => {
  const patterns = configIgnore.map(globToRegExp);
  return (relativePath) => {
    const segments = relativePath.split("/");
    for (const segment of segments) {
      if (segment.startsWith(".") && segment !== "." && segment !== "..") return true;
      if (DEFAULT_IGNORES.includes(segment)) return true;
    }
    return patterns.some((pattern) => pattern.test(relativePath));
  };
};
