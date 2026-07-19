import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  decodeManifestUnknown,
  mediaTypeForVaultPath,
  normalizeVaultPath,
  sha256Hex,
  VAULT_MANIFEST_SCHEMA,
  type VaultManifest,
  type VaultManifestEntry,
} from "./manifest.ts";
import {
  isIgnoredVaultPath,
  loadVaultIgnore,
  VAULT_STATE_DIRECTORY,
  type VaultIgnoreRules,
} from "./vaultIgnore.ts";

export { isIgnoredVaultPath, VAULT_STATE_DIRECTORY };

export interface ScanVaultOptions {
  readonly vaultId: string;
  readonly revision: string;
  readonly generatedAt: string;
}

export interface ApplyManifestOptions {
  /**
   * File hashes from the last synced manifest, used for three-way
   * last-write-wins resolution. Files whose local content matches the base are
   * fast-forwarded (or pruned when deleted remotely); files edited locally and
   * remotely are overwritten with the remote version after the local version is
   * copied into the conflicts directory.
   */
  readonly baseFiles?: ReadonlyMap<string, string>;
  /** Delete local files that the remote manifest no longer contains (only when unmodified locally). */
  readonly prune?: boolean;
  /** Ignore rules loaded for this pull operation. */
  readonly ignore?: VaultIgnoreRules;
}

export interface ApplyManifestResult {
  readonly created: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly unchanged: ReadonlyArray<string>;
  /** Locally modified files that lost to the remote version; the local bytes were copied to `localCopyPath`. */
  readonly conflicts: ReadonlyArray<{ readonly path: string; readonly localCopyPath: string }>;
  /** Files pruned because the remote manifest deleted them and the local copy was unmodified. */
  readonly deleted: ReadonlyArray<string>;
  /** Files deleted remotely but kept because they were modified locally. */
  readonly keptModified: ReadonlyArray<string>;
}

export class VaultRootNotDirectoryError extends Schema.TaggedErrorClass<VaultRootNotDirectoryError>()(
  "VaultRootNotDirectoryError",
  { root: Schema.String },
) {
  override get message(): string {
    return `Vault root is not a directory: ${this.root}`;
  }
}

export class VaultObjectIntegrityError extends Schema.TaggedErrorClass<VaultObjectIntegrityError>()(
  "VaultObjectIntegrityError",
  { path: Schema.String, digest: Schema.String },
) {
  override get message(): string {
    return `Object ${this.digest} failed integrity verification for ${this.path}.`;
  }
}

function collectEntries(
  root: string,
  current: string,
  ignore: VaultIgnoreRules,
): Effect.Effect<
  ReadonlyArray<VaultManifestEntry>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directoryEntries = (yield* fs.readDirectory(current)).toSorted((left, right) =>
      left.localeCompare(right),
    );
    const files: Array<VaultManifestEntry> = [];

    for (const name of directoryEntries) {
      const absolutePath = path.join(current, name);
      const canonicalPath = yield* fs.realPath(absolutePath).pipe(
        Effect.match({
          onFailure: () => null,
          onSuccess: (value) => path.normalize(value),
        }),
      );
      // The portable FileSystem stat operation follows links. Comparing the
      // canonical path before stat keeps both file and directory symlinks out.
      if (canonicalPath === null || canonicalPath !== path.normalize(absolutePath)) continue;
      const info = yield* fs.stat(absolutePath);
      const relativePath = normalizeVaultPath(path.relative(root, absolutePath));
      if (relativePath === null || isIgnoredVaultPath(relativePath, ignore)) continue;
      if (info.type === "Directory") {
        files.push(...(yield* collectEntries(root, absolutePath, ignore)));
        continue;
      }
      if (info.type !== "File") continue;
      const mediaType = mediaTypeForVaultPath(relativePath);
      if (mediaType === null) continue;
      const bytes = yield* fs.readFile(absolutePath);
      files.push({
        path: relativePath,
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
        mediaType,
      });
    }
    return files;
  });
}

export const scanVault = Effect.fn("scanVault")(function* (
  root: string,
  options: ScanVaultOptions,
  loadedIgnore?: VaultIgnoreRules,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absoluteRoot = yield* fs.realPath(path.resolve(root));
  const stats = yield* fs.stat(absoluteRoot);
  if (stats.type !== "Directory") {
    return yield* new VaultRootNotDirectoryError({ root: absoluteRoot });
  }
  const ignore = loadedIgnore ?? (yield* loadVaultIgnore(absoluteRoot));
  return yield* decodeManifestUnknown({
    schema: VAULT_MANIFEST_SCHEMA,
    vaultId: options.vaultId,
    revision: options.revision,
    generatedAt: options.generatedAt,
    files: yield* collectEntries(absoluteRoot, absoluteRoot, ignore),
  });
});

function resolveInside(path: Path.Path, root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root);
  const normalized = normalizeVaultPath(relativePath);
  if (normalized === null) {
    throw new Error(`Unsafe vault path: ${relativePath}`);
  }
  const destination = path.resolve(absoluteRoot, normalized);
  if (destination !== absoluteRoot && !destination.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Resolved path escapes the vault: ${relativePath}`);
  }
  return destination;
}

export const atomicWrite = Effect.fnUntraced(function* (destination: string, bytes: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destination);
  yield* fs.makeDirectory(directory, { recursive: true });
  const temporaryPath = yield* fs.makeTempFile({
    directory,
    prefix: `${path.basename(destination)}.apnatasks-`,
    suffix: ".tmp",
  });
  const temporaryDirectory = path.dirname(temporaryPath);
  yield* Effect.gen(function* () {
    yield* fs.writeFile(temporaryPath, bytes);
    yield* fs.rename(temporaryPath, destination);
  }).pipe(
    Effect.ensuring(Effect.ignore(fs.remove(temporaryDirectory, { force: true, recursive: true }))),
  );
});

const readIfFile = Effect.fnUntraced(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath))) return null;
  const stats = yield* fs.stat(filePath);
  if (stats.type !== "File") return null;
  return yield* fs.readFile(filePath);
});

export function conflictCopyPath(revision: string, filePath: string): string {
  return [VAULT_STATE_DIRECTORY, "conflicts", revision, filePath].join("/");
}

/**
 * Applies a remote manifest to the local vault with last-write-wins semantics.
 *
 * Local edits are never lost silently: when a file was modified both locally
 * and remotely, the local bytes are copied under
 * `.apnatasks/conflicts/<revision>/` before the remote version replaces them.
 */
export function applyVaultManifest<E, R>(
  root: string,
  manifest: VaultManifest,
  readObject: (digest: string) => Effect.Effect<Uint8Array, E, R>,
  options: ApplyManifestOptions = {},
): Effect.Effect<
  ApplyManifestResult,
  E | PlatformError.PlatformError | VaultObjectIntegrityError,
  R | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseFiles = options.baseFiles ?? new Map<string, string>();
    const absoluteRoot = path.resolve(root);
    yield* fs.makeDirectory(absoluteRoot, { recursive: true });
    const created: Array<string> = [];
    const updated: Array<string> = [];
    const unchanged: Array<string> = [];
    const conflicts: Array<{ path: string; localCopyPath: string }> = [];
    const deleted: Array<string> = [];
    const keptModified: Array<string> = [];
    const ignore = options.ignore;

    for (const entry of manifest.files) {
      if (isIgnoredVaultPath(entry.path, ignore)) continue;
      const destination = resolveInside(path, absoluteRoot, entry.path);
      const localBytes = yield* readIfFile(destination);
      if (localBytes !== null && sha256Hex(localBytes) === entry.sha256) {
        unchanged.push(entry.path);
        continue;
      }

      const remoteBytes = yield* readObject(entry.sha256);
      if (remoteBytes.byteLength !== entry.size || sha256Hex(remoteBytes) !== entry.sha256) {
        return yield* new VaultObjectIntegrityError({ path: entry.path, digest: entry.sha256 });
      }

      if (localBytes === null) {
        yield* atomicWrite(destination, remoteBytes);
        created.push(entry.path);
        continue;
      }

      const localDigest = sha256Hex(localBytes);
      if (baseFiles.get(entry.path) === localDigest) {
        // Local copy is untouched since the last sync: fast-forward to remote.
        yield* atomicWrite(destination, remoteBytes);
        updated.push(entry.path);
        continue;
      }

      // Modified locally and remotely: remote wins, keep the local version.
      const localCopyPath = conflictCopyPath(manifest.revision, entry.path);
      yield* atomicWrite(resolveInside(path, absoluteRoot, localCopyPath), localBytes);
      yield* atomicWrite(destination, remoteBytes);
      conflicts.push({ path: entry.path, localCopyPath });
    }

    if (options.prune === true) {
      const remotePaths = new Set(manifest.files.map((entry) => entry.path));
      for (const [basePath, baseDigest] of baseFiles) {
        if (isIgnoredVaultPath(basePath, ignore)) continue;
        if (remotePaths.has(basePath)) continue;
        const destination = resolveInside(path, absoluteRoot, basePath);
        const localBytes = yield* readIfFile(destination);
        if (localBytes === null) continue;
        if (sha256Hex(localBytes) === baseDigest) {
          yield* fs.remove(destination, { force: true });
          deleted.push(basePath);
        } else {
          keptModified.push(basePath);
        }
      }
    }

    return { created, updated, unchanged, conflicts, deleted, keptModified };
  });
}
