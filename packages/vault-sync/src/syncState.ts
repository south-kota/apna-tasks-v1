import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { VaultManifest } from "./manifest.ts";
import { atomicWrite, VAULT_STATE_DIRECTORY } from "./vault.ts";

export const SYNC_STATE_SCHEMA = 1 as const;

/**
 * Local record of the last manifest this vault synchronized with, plus the
 * ETag the server reported for it. Acts as the base for three-way
 * last-write-wins resolution and for conditional manifest updates.
 */
export const VaultSyncState = Schema.Struct({
  schema: Schema.Literal(SYNC_STATE_SCHEMA),
  etag: Schema.String,
  manifest: VaultManifest,
});
export type VaultSyncState = typeof VaultSyncState.Type;

const VaultSyncStateJson = fromJsonStringPretty(VaultSyncState);
const decodeState = Schema.decodeEffect(VaultSyncStateJson);
const encodeState = Schema.encodeEffect(VaultSyncStateJson);

const statePath = (path: Path.Path, root: string): string =>
  path.join(root, VAULT_STATE_DIRECTORY, "sync", "state.json");

/** Reads the last-synced state, or `null` when missing or unreadable. */
export const readSyncState = Effect.fn("readSyncState")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = statePath(path, root);
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return null;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap((content) => decodeState(content)),
    Effect.orElseSucceed(() => null),
  );
});

export const writeSyncState = Effect.fn("writeSyncState")(function* (
  root: string,
  state: VaultSyncState,
) {
  const path = yield* Path.Path;
  const encoded = yield* encodeState(state);
  yield* atomicWrite(statePath(path, root), new TextEncoder().encode(encoded));
});

export function baseFilesFromState(state: VaultSyncState | null): ReadonlyMap<string, string> {
  const baseFiles = new Map<string, string>();
  if (state !== null) {
    for (const entry of state.manifest.files) {
      baseFiles.set(entry.path, entry.sha256);
    }
  }
  return baseFiles;
}
