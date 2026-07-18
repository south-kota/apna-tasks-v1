/**
 * Atomic, non-destructive file operations for JBOM vaults.
 *
 * - Writes go through a temp file + rename in the target directory, so a
 *   crash never leaves a half-written record.
 * - Renames refuse to clobber an existing target by default.
 * - Deletes are soft: the file moves into the vault's trash directory
 *   (`<runtimeDir>/trash/<timestamp>/<relative-path>`), never `rm`.
 *
 * @module FileOps
 */
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class JbomFileError extends Schema.TaggedErrorClass<JbomFileError>()("JbomFileError", {
  operation: Schema.Literals(["write", "rename", "trash"]),
  path: Schema.String,
  message: Schema.String,
}) {}

type FileOpsRequirements = FileSystem.FileSystem | Path.Path;

const wrapError = (operation: "write" | "rename" | "trash", path: string) => (error: unknown) =>
  new JbomFileError({
    operation,
    path,
    message: error instanceof Error ? error.message : String(error),
  });

/**
 * Atomically writes `contents` to `filePath`: the bytes land in a temp file in
 * the same directory, then a single `rename` makes them visible.
 */
export const writeFileAtomic = Effect.fn("writeFileAtomic")(function* (
  filePath: string,
  contents: string,
): Effect.fn.Return<void, JbomFileError, FileOpsRequirements> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${NodeCrypto.randomUUID().slice(0, 13)}.tmp`,
  );

  yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.catch(() => Effect.void));
  yield* fs.writeFileString(tempPath, contents).pipe(Effect.mapError(wrapError("write", filePath)));
  yield* fs.rename(tempPath, filePath).pipe(
    Effect.tapError(() =>
      fs.remove(tempPath, { force: true }).pipe(Effect.orElseSucceed(() => undefined)),
    ),
    Effect.mapError(wrapError("write", filePath)),
  );
});

/**
 * Renames a file, creating the target directory when needed. Fails with a
 * `JbomFileError` when the target already exists, unless `overwrite` is set.
 */
export const renameFile = Effect.fn("renameFile")(function* (
  fromPath: string,
  toPath: string,
  options?: { readonly overwrite?: boolean },
): Effect.fn.Return<void, JbomFileError, FileOpsRequirements> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (options?.overwrite !== true) {
    const exists = yield* fs.exists(toPath).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return yield* new JbomFileError({
        operation: "rename",
        path: toPath,
        message: `Rename target already exists: ${toPath}`,
      });
    }
  }

  yield* fs
    .makeDirectory(path.dirname(toPath), { recursive: true })
    .pipe(Effect.catch(() => Effect.void));
  yield* fs.rename(fromPath, toPath).pipe(Effect.mapError(wrapError("rename", fromPath)));
});

/**
 * Soft-deletes a vault file by moving it into the trash directory, preserving
 * its vault-relative path under a timestamped folder. Returns the trash path.
 */
export const trashFile = Effect.fn("trashFile")(function* (options: {
  readonly vaultRoot: string;
  /** Vault-relative POSIX path of the file to trash. */
  readonly relativePath: string;
  /** Runtime dir relative to the vault root. Defaults to `.jbom`. */
  readonly runtimeDir?: string;
}): Effect.fn.Return<string, JbomFileError, FileOpsRequirements> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = options.runtimeDir ?? ".jbom";
  const timestamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
  const trashPath = path.join(
    options.vaultRoot,
    runtimeDir,
    "trash",
    timestamp,
    options.relativePath,
  );
  const sourcePath = path.join(options.vaultRoot, options.relativePath);

  yield* fs
    .makeDirectory(path.dirname(trashPath), { recursive: true })
    .pipe(Effect.mapError(wrapError("trash", trashPath)));
  yield* fs.rename(sourcePath, trashPath).pipe(Effect.mapError(wrapError("trash", sourcePath)));
  return trashPath;
});
