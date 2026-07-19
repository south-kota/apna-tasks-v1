import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { atomicWrite, VAULT_STATE_DIRECTORY } from "./vault.ts";

export const SYNC_STATUS_SCHEMA = 1 as const;
export const SYNC_STATUS_STALE_AFTER_MS = 5 * 60 * 1_000;

export const SyncStatusState = Schema.Literals(["clean", "pending", "pushing", "pulling", "error"]);
export type SyncStatusState = typeof SyncStatusState.Type;

const isoDateTimeFilter = Schema.makeFilter(
  (value: string) =>
    DateTime.make(value)._tag === "Some" || "Sync status timestamps must be ISO date-time strings.",
);
const IsoDateTime = Schema.String.check(isoDateTimeFilter);

/**
 * Cheap, vault-local summary of sync activity. `updatedAt` lets readers treat
 * an old `pushing` or `pulling` state as stale after an interrupted process.
 */
export const VaultSyncStatus = Schema.Struct({
  schema: Schema.Literal(SYNC_STATUS_SCHEMA),
  state: SyncStatusState,
  updatedAt: IsoDateTime,
  lastSuccessfulSyncAt: Schema.NullOr(IsoDateTime),
  lastPushedRevision: Schema.NullOr(Schema.String),
  lastPulledRevision: Schema.NullOr(Schema.String),
  pendingPaths: Schema.Array(Schema.String),
  lastError: Schema.NullOr(Schema.String),
}).check(
  Schema.makeFilter((status) => {
    if (status.state === "clean" && status.pendingPaths.length > 0) {
      return "A clean sync status cannot contain pending paths.";
    }
    if (status.state === "pending" && status.pendingPaths.length === 0) {
      return "A pending sync status must contain at least one path.";
    }
    if (status.state === "error" && status.lastError === null) {
      return "An error sync status must contain the last error message.";
    }
    if (status.state !== "error" && status.lastError !== null) {
      return "Only an error sync status can contain the last error message.";
    }
    return true;
  }),
);
export type VaultSyncStatus = typeof VaultSyncStatus.Type;

const VaultSyncStatusJson = fromJsonStringPretty(VaultSyncStatus);
const decodeStatus = Schema.decodeEffect(VaultSyncStatusJson);
const encodeStatus = Schema.encodeEffect(VaultSyncStatusJson);

const statusPath = (path: Path.Path, root: string): string =>
  path.join(root, VAULT_STATE_DIRECTORY, "sync", "status.json");

/** Reads the sync status, or `null` when the file is missing or unreadable. */
export const readSyncStatus = Effect.fn("readSyncStatus")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = statusPath(path, root);
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return null;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap((content) => decodeStatus(content)),
    Effect.orElseSucceed(() => null),
  );
});

/** Atomically replaces the vault-local sync status file. */
export const writeSyncStatus = Effect.fn("writeSyncStatus")(function* (
  root: string,
  status: VaultSyncStatus,
) {
  const path = yield* Path.Path;
  const encoded = yield* encodeStatus(status);
  yield* atomicWrite(statusPath(path, root), new TextEncoder().encode(encoded));
});

export interface SyncStatusTransition {
  readonly state: SyncStatusState;
  readonly pendingPaths?: ReadonlyArray<string>;
  readonly lastError?: string;
  readonly lastPushedRevision?: string;
  readonly lastPulledRevision?: string;
  /** Marks this transition as a completed, fully synchronized state. */
  readonly successful?: boolean;
}

function sortedUnique(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(paths)].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Moves the status to a new lifecycle state while retaining prior successful
 * sync metadata and revision history.
 */
export const updateSyncStatus = Effect.fn("updateSyncStatus")(function* (
  root: string,
  transition: SyncStatusTransition,
) {
  const previous = yield* readSyncStatus(root);
  const updatedAt = DateTime.formatIso(yield* DateTime.now);
  const pendingPaths =
    transition.state === "clean"
      ? []
      : sortedUnique(transition.pendingPaths ?? previous?.pendingPaths ?? []);
  const status: VaultSyncStatus = {
    schema: SYNC_STATUS_SCHEMA,
    state: transition.state,
    updatedAt,
    lastSuccessfulSyncAt:
      transition.successful === true ? updatedAt : (previous?.lastSuccessfulSyncAt ?? null),
    lastPushedRevision: transition.lastPushedRevision ?? previous?.lastPushedRevision ?? null,
    lastPulledRevision: transition.lastPulledRevision ?? previous?.lastPulledRevision ?? null,
    pendingPaths,
    lastError: transition.state === "error" ? syncErrorMessage(transition.lastError ?? "") : null,
  };
  yield* writeSyncStatus(root, status);
  return status;
});

/** Whether an in-progress status is old enough that readers should distrust it. */
export function isSyncStatusStale(
  status: VaultSyncStatus,
  now: number,
  staleAfterMs = SYNC_STATUS_STALE_AFTER_MS,
): boolean {
  if (status.state !== "pushing" && status.state !== "pulling") return false;
  const updatedAt = Date.parse(status.updatedAt);
  return !Number.isFinite(updatedAt) || now - updatedAt >= staleAfterMs;
}

/** Stable, bounded message suitable for the machine-readable status file. */
export function syncErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replaceAll(/\s+/gu, " ").trim().slice(0, 500);
  return compact.length === 0 ? "Unknown sync error" : compact;
}
