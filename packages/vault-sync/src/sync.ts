import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { VaultCloudClient } from "./client.ts";
import { sameManifestContent, type VaultManifest } from "./manifest.ts";
import {
  baseFilesFromState,
  readSyncState,
  writeSyncState,
  SYNC_STATE_SCHEMA,
} from "./syncState.ts";
import { readSyncStatus, type VaultSyncStatus } from "./syncStatus.ts";
import { applyVaultManifest, scanVault, type ApplyManifestResult } from "./vault.ts";
import { isIgnoredVaultPath, loadVaultIgnore } from "./vaultIgnore.ts";

export class RemoteManifestChangedError extends Schema.TaggedErrorClass<RemoteManifestChangedError>()(
  "RemoteManifestChangedError",
  { vaultId: Schema.String },
) {
  override get message(): string {
    return `Remote vault ${this.vaultId} changed since the last sync. Pull first (local edits are preserved as conflict copies), then push again.`;
  }
}

export class RemoteVaultNotFoundError extends Schema.TaggedErrorClass<RemoteVaultNotFoundError>()(
  "RemoteVaultNotFoundError",
  { vaultId: Schema.String },
) {
  override get message(): string {
    return `Remote vault does not exist: ${this.vaultId}`;
  }
}

export interface PushVaultOptions {
  readonly root: string;
  readonly vaultId: string;
  readonly revision: string;
  readonly generatedAt: string;
  readonly client: VaultCloudClient;
  /** Overwrite the remote manifest even when it changed since the last sync. */
  readonly force?: boolean;
}

export const pushVault = Effect.fn("pushVault")(function* (options: PushVaultOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ignore = yield* loadVaultIgnore(options.root);
  const manifest = yield* scanVault(options.root, options, ignore);
  const state = yield* readSyncState(options.root);
  const remote = yield* options.client.getManifest(options.vaultId);

  if (remote !== null && sameManifestContent(remote.manifest, manifest)) {
    yield* writeSyncState(options.root, {
      schema: SYNC_STATE_SCHEMA,
      etag: remote.etag,
      manifest: remote.manifest,
    });
    return { manifest: remote.manifest, etag: remote.etag, uploaded: 0 };
  }

  // Conditional update: push only on top of the revision this vault last saw,
  // unless forced. A stale local state surfaces as RemoteManifestChangedError.
  const lastSeenEtag = state?.etag ?? null;
  if (options.force !== true && remote !== null && remote.etag !== lastSeenEtag) {
    return yield* new RemoteManifestChangedError({ vaultId: options.vaultId });
  }
  const expectedEtag = remote === null ? null : options.force === true ? remote.etag : lastSeenEtag;

  let uploaded = 0;
  // Objects referenced by the remote manifest necessarily exist in the store,
  // so only genuinely new content needs an existence probe. This keeps a push
  // at O(changed files) requests instead of probing the whole vault.
  const knownDigests = new Set((remote?.manifest.files ?? []).map((entry) => entry.sha256));
  for (const entry of manifest.files) {
    if (knownDigests.has(entry.sha256)) continue;
    if (yield* options.client.objectExists(options.vaultId, entry.sha256)) {
      knownDigests.add(entry.sha256);
      continue;
    }
    const bytes = yield* fs.readFile(path.join(options.root, ...entry.path.split("/")));
    yield* options.client.uploadObject(options.vaultId, entry.sha256, bytes, entry.mediaType);
    knownDigests.add(entry.sha256);
    uploaded += 1;
  }

  const etag = yield* options.client.putManifest(manifest, expectedEtag);
  yield* writeSyncState(options.root, { schema: SYNC_STATE_SCHEMA, etag, manifest });
  return { manifest, etag, uploaded };
});

export interface PullVaultOptions {
  readonly root: string;
  readonly vaultId: string;
  readonly client: VaultCloudClient;
  /** Delete local files the remote manifest no longer contains (only when unmodified locally). Defaults to true. */
  readonly prune?: boolean;
}

export const pullVault = Effect.fn("pullVault")(function* (options: PullVaultOptions) {
  const ignore = yield* loadVaultIgnore(options.root);
  const remote = yield* options.client.getManifest(options.vaultId);
  if (remote === null) return yield* new RemoteVaultNotFoundError({ vaultId: options.vaultId });
  const state = yield* readSyncState(options.root);
  const result: ApplyManifestResult = yield* applyVaultManifest(
    options.root,
    remote.manifest,
    (digest) => options.client.downloadObject(options.vaultId, digest),
    { baseFiles: baseFilesFromState(state), prune: options.prune ?? true, ignore },
  );
  yield* writeSyncState(options.root, {
    schema: SYNC_STATE_SCHEMA,
    etag: remote.etag,
    manifest: remote.manifest,
  });
  return { manifest: remote.manifest, etag: remote.etag, result };
});

/**
 * Paths that differ between the working tree and the last-synced state — the
 * offline backlog a watch daemon must flush at startup, since FS events for
 * these changes (if any ever fired) happened while nothing was watching.
 * Compares against local sync state only; no network. New files, modified
 * files, and locally deleted files all count. A vault with no sync state is
 * entirely dirty (first daemon run on an existing tree).
 */
export const localDirtyPaths = Effect.fn("localDirtyPaths")(function* (root: string) {
  const ignore = yield* loadVaultIgnore(root);
  const state = yield* readSyncState(root);
  const local = yield* scanVault(
    root,
    { vaultId: "dirty-scan", revision: "dirty-scan", generatedAt: "1970-01-01T00:00:00.000Z" },
    ignore,
  );
  const baseFiles = new Map(baseFilesFromState(state));
  const dirty: Array<string> = [];
  for (const entry of local.files) {
    const baseDigest = baseFiles.get(entry.path);
    if (baseDigest !== entry.sha256) dirty.push(entry.path);
    baseFiles.delete(entry.path);
  }
  for (const deletedPath of baseFiles.keys()) {
    dirty.push(deletedPath);
  }
  return dirty.toSorted();
});

export interface VaultStatus {
  readonly syncStatus: VaultSyncStatus | null;
  readonly remote: { readonly revision: string; readonly etag: string } | null;
  readonly inSync: boolean;
  /** Files present locally but absent remotely. */
  readonly localOnly: ReadonlyArray<string>;
  /** Files present remotely but absent locally. */
  readonly remoteOnly: ReadonlyArray<string>;
  /** Files whose content differs between local and remote. */
  readonly modified: ReadonlyArray<string>;
}

export interface StatusVaultOptions {
  readonly root: string;
  readonly vaultId: string;
  readonly revision: string;
  readonly generatedAt: string;
  readonly client: VaultCloudClient;
}

export const statusVault = Effect.fn("statusVault")(function* (options: StatusVaultOptions) {
  const ignore = yield* loadVaultIgnore(options.root);
  const local = yield* scanVault(options.root, options, ignore);
  const remote = yield* options.client.getManifest(options.vaultId);
  const syncStatus = yield* readSyncStatus(options.root);
  const remoteFiles = new Map<string, string>(
    (remote?.manifest ?? emptyManifest).files
      .filter((entry) => !isIgnoredVaultPath(entry.path, ignore))
      .map((entry) => [entry.path, entry.sha256]),
  );

  const localOnly: Array<string> = [];
  const modified: Array<string> = [];
  for (const entry of local.files) {
    const remoteDigest = remoteFiles.get(entry.path);
    if (remoteDigest === undefined) localOnly.push(entry.path);
    else if (remoteDigest !== entry.sha256) modified.push(entry.path);
  }
  const localPaths = new Set(local.files.map((entry) => entry.path));
  const remoteOnly = [...remoteFiles.keys()].filter((filePath) => !localPaths.has(filePath));

  const status: VaultStatus = {
    syncStatus,
    remote: remote === null ? null : { revision: remote.manifest.revision, etag: remote.etag },
    inSync:
      remote !== null && localOnly.length === 0 && remoteOnly.length === 0 && modified.length === 0,
    localOnly,
    remoteOnly,
    modified,
  };
  return status;
});

const emptyManifest: Pick<VaultManifest, "files"> = { files: [] };
