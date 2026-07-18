/**
 * Vault scanning: walking content roots with ignore rules and running the
 * parse → scan → validate pipeline for single files. Shared by the SQLite
 * index (rebuild + incremental) and the JSON exporter so both always agree.
 *
 * @module Scan
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeIgnoreMatcher, type ResolvedConfig } from "./Config.ts";
import * as Frontmatter from "./Frontmatter.ts";
import * as Markdown from "./Markdown.ts";
import type { RecordAnalysis } from "./Model.ts";
import { analyzeRecord } from "./Validate.ts";

export interface AnalyzedFile {
  readonly analysis: RecordAnalysis;
  readonly parsed: Frontmatter.ParsedDocument;
  readonly scan: Markdown.BodyScan;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

const toPosix = (value: string): string => value.split("\\").join("/");

/** Lists all vault-relative Markdown file paths under the content roots. */
export const listMarkdownFiles = Effect.fn("listMarkdownFiles")(function* (
  vaultRoot: string,
  config: ResolvedConfig,
): Effect.fn.Return<Array<string>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isIgnored = makeIgnoreMatcher(config.ignore);
  const results: Array<string> = [];
  const seen = new Set<string>();

  const walk: (relativeDir: string) => Effect.Effect<void> = Effect.fn("walk")(function* (
    relativeDir: string,
  ) {
    const absolute = relativeDir === "." ? vaultRoot : path.join(vaultRoot, relativeDir);
    const entries = yield* fs.readDirectory(absolute).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const relative = relativeDir === "." ? toPosix(entry) : `${relativeDir}/${toPosix(entry)}`;
      if (isIgnored(relative) || seen.has(relative)) continue;
      const info = yield* fs
        .stat(path.join(vaultRoot, relative))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (info === undefined) continue;
      if (info.type === "Directory") {
        seen.add(relative);
        yield* walk(relative);
      } else if (info.type === "File" && relative.toLowerCase().endsWith(".md")) {
        seen.add(relative);
        results.push(relative);
      }
    }
  });

  for (const root of config.contentRoots) {
    const normalized = toPosix(root).replace(/^\.\/?/, "") || ".";
    yield* walk(normalized === "" ? "." : normalized);
  }

  results.sort();
  return results;
});

/** Reads and analyzes one vault file. Returns `undefined` when unreadable. */
export const analyzeFile = Effect.fn("analyzeFile")(function* (
  vaultRoot: string,
  relativePath: string,
  config: ResolvedConfig,
): Effect.fn.Return<AnalyzedFile | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(vaultRoot, relativePath);

  const contents = yield* fs.readFileString(absolute).pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return undefined;
  const info = yield* fs.stat(absolute).pipe(Effect.orElseSucceed(() => undefined));

  const parsed = Frontmatter.parse(contents);
  const scan = Markdown.scanBody(parsed.body, parsed.frontmatter?.lineCount ?? 0);
  const analysis = analyzeRecord({ path: relativePath, parsed, scan, types: config.types });

  return {
    analysis,
    parsed,
    scan,
    sizeBytes: contents.length,
    mtimeMs: info?.mtime._tag === "Some" ? info.mtime.value.getTime() : 0,
  };
});
