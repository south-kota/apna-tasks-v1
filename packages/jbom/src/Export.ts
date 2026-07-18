/**
 * JSON export: vault → machine-readable records (spec ch. 07). The export is
 * a derived artifact built straight from the Markdown corpus using the same
 * parse/validate pipeline as the index, so the two always agree.
 *
 * @module Export
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { ResolvedConfig } from "./Config.ts";
import type { Diagnostic } from "./Model.ts";
import { analyzeFile, listMarkdownFiles } from "./Scan.ts";

export interface ExportedRecord {
  readonly path: string;
  readonly type: string | undefined;
  readonly recognizedType: boolean;
  readonly valid: boolean;
  readonly id: string | undefined;
  readonly title: string | undefined;
  /** Full frontmatter mapping, unknown fields included. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tags: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  /** Markdown body, present unless the export was asked to omit bodies. */
  readonly body?: string;
}

export interface VaultExport {
  readonly jbomExport: "1";
  readonly generatedAt: string;
  readonly vaultName: string | undefined;
  readonly fileCount: number;
  readonly records: ReadonlyArray<ExportedRecord>;
}

/** Builds the JSON export structure for a vault. Read-only. */
export const exportVault = Effect.fn("exportVault")(function* (options: {
  readonly vaultRoot: string;
  readonly config: ResolvedConfig;
  readonly includeBody?: boolean;
}): Effect.fn.Return<VaultExport, never, FileSystem.FileSystem | Path.Path> {
  const { vaultRoot, config } = options;
  const includeBody = options.includeBody ?? true;
  const files = yield* listMarkdownFiles(vaultRoot, config);
  const records: Array<ExportedRecord> = [];

  for (const file of files) {
    const analyzed = yield* analyzeFile(vaultRoot, file, config);
    if (analyzed === undefined) continue;
    const { analysis } = analyzed;
    records.push({
      path: analysis.path,
      type: analysis.type,
      recognizedType: analysis.recognizedType,
      valid: analysis.valid,
      id: analysis.id,
      title: analysis.title,
      frontmatter: analysis.frontmatter,
      tags: analysis.tags,
      diagnostics: analysis.diagnostics,
      ...(includeBody ? { body: analyzed.parsed.body } : {}),
    });
  }

  return {
    jbomExport: "1",
    generatedAt: DateTime.formatIso(yield* DateTime.now),
    vaultName: config.name,
    fileCount: records.length,
    records,
  };
});
