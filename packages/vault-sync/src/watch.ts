import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ManifestPreconditionError } from "./client.ts";
import { RemoteManifestChangedError } from "./sync.ts";
import { syncErrorMessage, updateSyncStatus } from "./syncStatus.ts";
import { isIgnoredVaultPath, loadVaultIgnore } from "./vaultIgnore.ts";

export const WATCH_DEBOUNCE = Duration.seconds(2);
export const WATCH_POLL_INTERVAL = Duration.seconds(10);

export interface WatchPushResult {
  readonly revision: string;
}

export interface WatchPullResult {
  readonly revision: string;
}

export interface WatchSyncOperations<PushError, PullError, Requirements> {
  readonly push: () => Effect.Effect<WatchPushResult, PushError, Requirements>;
  readonly pull: () => Effect.Effect<WatchPullResult, PullError, Requirements>;
}

export interface WatchRemoteRevisions<CheckError, Requirements> {
  readonly remote: () => Effect.Effect<string | null, CheckError, Requirements>;
  readonly local: () => Effect.Effect<string | null, CheckError, Requirements>;
}

export interface VaultWatchOptions<CheckError, Requirements> {
  /** Set to zero to disable interval polls. Startup reconciliation still runs. */
  readonly pollInterval?: Duration.Input;
  readonly revisions?: WatchRemoteRevisions<CheckError, Requirements>;
}

export interface WatchCycleResult extends WatchPushResult {
  readonly retried: boolean;
  readonly pulledRevision: string | null;
}

const isRemoteManifestChangedError = Schema.is(RemoteManifestChangedError);
const isManifestPreconditionError = Schema.is(ManifestPreconditionError);

function isStalePushError(error: unknown): boolean {
  return isRemoteManifestChangedError(error) || isManifestPreconditionError(error);
}

/** Pushes once, reconciling a stale remote with one pull and one retry. */
export function runWatchCycle<PushError, PullError, Requirements>(
  operations: WatchSyncOperations<PushError, PullError, Requirements>,
): Effect.Effect<WatchCycleResult, PushError | PullError, Requirements> {
  return operations.push().pipe(
    Effect.map((result) => ({ ...result, retried: false, pulledRevision: null })),
    Effect.catch((error) => {
      if (!isStalePushError(error)) return Effect.fail(error);
      return Effect.gen(function* () {
        const pulled = yield* operations.pull();
        const result = yield* operations.push();
        return { ...result, retried: true, pulledRevision: pulled.revision };
      });
    }),
  );
}

/**
 * Debounces a stream of vault-relative paths into sorted, unique batches.
 * Every event restarts the quiet-period timer.
 */
export function debounceWatchEvents<Error, Requirements>(
  events: Stream.Stream<string, Error, Requirements>,
  debounce: Duration.Input = WATCH_DEBOUNCE,
): Stream.Stream<ReadonlyArray<string>, Error, Requirements> {
  return Stream.callback<ReadonlyArray<string>, Error, Requirements>((output) =>
    Effect.gen(function* () {
      const inbox = yield* Queue.make<string, Error | Cause.Done>();
      yield* events.pipe(
        Stream.runForEach((event) => Queue.offer(inbox, event)),
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? Queue.failCause(inbox, exit.cause).pipe(Effect.asVoid)
            : Queue.end(inbox).pipe(Effect.asVoid),
        ),
        Effect.forkScoped,
      );

      const pump = Effect.gen(function* () {
        while (true) {
          const first = yield* Queue.take(inbox);
          const pending = new Set([first]);
          while (true) {
            const next = yield* Queue.take(inbox).pipe(Effect.timeoutOption(debounce));
            if (Option.isNone(next)) break;
            pending.add(next.value);
          }
          yield* Queue.offer(output, [...pending].toSorted());
        }
      });

      yield* pump.pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? Queue.failCause(output, exit.cause).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
    }),
  );
}

function watchedPath(input: string): Result.Result<string, void> {
  const relativePath = input.replaceAll("\\", "/");
  return isIgnoredVaultPath(relativePath) ? Result.failVoid : Result.succeed(relativePath);
}

/** Recursive filesystem events filtered with the same directory ignores as vault scans. */
export function watchVaultEvents(
  root: string,
  debounce: Duration.Input = WATCH_DEBOUNCE,
): Stream.Stream<ReadonlyArray<string>, PlatformError.PlatformError, FileSystem.FileSystem> {
  const events = Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return fs.watch(root).pipe(Stream.filterMap((event) => watchedPath(event.path)));
    }),
  );
  return debounceWatchEvents(events, debounce);
}

function runIncludedWatchBatch<PushError, PullError, Requirements>(
  root: string,
  paths: ReadonlyArray<string>,
  operations: WatchSyncOperations<PushError, PullError, Requirements>,
) {
  return Effect.gen(function* () {
    yield* updateSyncStatus(root, { state: "pending", pendingPaths: paths });
    const result = yield* runWatchCycle({
      push: () =>
        Effect.gen(function* () {
          yield* updateSyncStatus(root, { state: "pushing", pendingPaths: paths });
          return yield* operations.push();
        }),
      pull: () =>
        Effect.gen(function* () {
          yield* updateSyncStatus(root, { state: "pulling", pendingPaths: paths });
          const pulled = yield* operations.pull();
          yield* updateSyncStatus(root, {
            state: "pulling",
            pendingPaths: paths,
            lastPulledRevision: pulled.revision,
          });
          return pulled;
        }),
    });
    yield* updateSyncStatus(root, {
      state: "clean",
      lastPushedRevision: result.revision,
      ...(result.pulledRevision === null ? {} : { lastPulledRevision: result.pulledRevision }),
      successful: true,
    });
    yield* Console.log(
      `${paths.length} files changed; pushed revision ${result.revision}${
        result.retried ? " after stale pull" : ""
      }.`,
    );
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt;
      const message = syncErrorMessage(Cause.squash(cause));
      return updateSyncStatus(root, {
        state: "error",
        pendingPaths: paths,
        lastError: message,
      }).pipe(
        Effect.catchCause((statusCause) =>
          Console.error(
            `Could not write vault sync error status: ${syncErrorMessage(Cause.squash(statusCause))}`,
          ),
        ),
        Effect.andThen(Console.error(`${paths.length} files changed; push failed: ${message}`)),
      );
    }),
  );
}

function runWatchBatch<PushError, PullError, Requirements>(
  root: string,
  paths: ReadonlyArray<string>,
  operations: WatchSyncOperations<PushError, PullError, Requirements>,
) {
  return Effect.gen(function* () {
    const ignore = yield* loadVaultIgnore(root);
    const includedPaths = paths.filter((filePath) => !isIgnoredVaultPath(filePath, ignore));
    if (includedPaths.length === 0) return;
    yield* runIncludedWatchBatch(root, includedPaths, operations);
  });
}

function recordReconcileFailure(root: string, cause: Cause.Cause<unknown>) {
  if (Cause.hasInterrupts(cause)) return Effect.interrupt;
  const message = syncErrorMessage(Cause.squash(cause));
  return updateSyncStatus(root, { state: "error", lastError: message }).pipe(
    Effect.catchCause((statusCause) =>
      Console.error(
        `Could not write vault sync error status: ${syncErrorMessage(Cause.squash(statusCause))}`,
      ),
    ),
    Effect.andThen(Console.error(`Remote reconciliation failed: ${message}`)),
    Effect.as(false),
  );
}

/** Checks the remote cheaply and pulls only when its revision differs from local sync state. */
function reconcileRemote<CheckError, PullError, CheckRequirements, PullRequirements>(
  root: string,
  revisions: WatchRemoteRevisions<CheckError, CheckRequirements>,
  pull: () => Effect.Effect<WatchPullResult, PullError, PullRequirements>,
  recoveringFromReconcileError: boolean,
) {
  return Effect.gen(function* () {
    const remoteRevision = yield* revisions.remote();
    if (remoteRevision === null) {
      if (recoveringFromReconcileError) yield* updateSyncStatus(root, { state: "clean" });
      return true;
    }
    const localRevision = yield* revisions.local();
    if (localRevision === remoteRevision) {
      if (recoveringFromReconcileError) {
        yield* updateSyncStatus(root, { state: "clean", successful: true });
      }
      return true;
    }

    yield* updateSyncStatus(root, { state: "pulling" });
    const pulled = yield* pull();
    yield* updateSyncStatus(root, {
      state: "clean",
      lastPulledRevision: pulled.revision,
      successful: true,
    });
    yield* Console.log(`Pulled remote revision ${pulled.revision}.`);
    return true;
  }).pipe(Effect.catchCause((cause) => recordReconcileFailure(root, cause)));
}

/** Runs already-batched watch events serially. Exported for deterministic daemon tests. */
export function runVaultWatchBatches<
  BatchError,
  PushError,
  PullError,
  BatchRequirements,
  Requirements,
  CheckError = never,
  CheckRequirements = never,
>(
  root: string,
  batches: Stream.Stream<ReadonlyArray<string>, BatchError, BatchRequirements>,
  operations: WatchSyncOperations<PushError, PullError, Requirements>,
  options: VaultWatchOptions<CheckError, CheckRequirements> = {},
) {
  if (options.revisions === undefined) {
    return batches.pipe(Stream.runForEach((paths) => runWatchBatch(root, paths, operations)));
  }

  const revisions = options.revisions;
  const pollInterval = options.pollInterval ?? WATCH_POLL_INTERVAL;
  const retryInterval = Duration.toMillis(pollInterval) > 0 ? pollInterval : WATCH_POLL_INTERVAL;
  return Effect.scoped(
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const reconciled = yield* Ref.make(false);
      const reconcileFailed = yield* Ref.make(false);
      const reconcile = Effect.gen(function* () {
        const wasFailed = yield* Ref.get(reconcileFailed);
        const success = yield* reconcileRemote(root, revisions, operations.pull, wasFailed);
        yield* Ref.set(reconciled, success);
        yield* Ref.set(reconcileFailed, !success);
        return success;
      });
      const attemptReconcile = lock.withPermit(reconcile);

      // This completes before either the watcher or poller starts, so a fresh
      // replica cannot publish an empty manifest before seeing the remote.
      yield* attemptReconcile;

      if (Duration.toMillis(pollInterval) > 0) {
        yield* Effect.sleep(pollInterval).pipe(
          Effect.andThen(attemptReconcile),
          Effect.forever,
          Effect.forkScoped,
        );
      }

      yield* batches.pipe(
        Stream.runForEach((paths) =>
          Effect.gen(function* () {
            while (true) {
              const processed = yield* lock.withPermit(
                Effect.gen(function* () {
                  if (!(yield* Ref.get(reconciled))) {
                    const success = yield* reconcile;
                    if (!success) return false;
                  }
                  yield* runWatchBatch(root, paths, operations);
                  return true;
                }),
              );
              if (processed) return;
              yield* Effect.sleep(retryInterval);
            }
          }),
        ),
      );
    }),
  );
}

/** Runs watch batches serially; cycle failures are logged and never end the daemon. */
export function runVaultWatch<
  PushError,
  PullError,
  Requirements,
  CheckError = never,
  CheckRequirements = never,
>(
  root: string,
  operations: WatchSyncOperations<PushError, PullError, Requirements>,
  options: VaultWatchOptions<CheckError, CheckRequirements> & {
    readonly revisions: WatchRemoteRevisions<CheckError, CheckRequirements>;
  },
): Effect.Effect<
  void,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Requirements | CheckRequirements
> {
  return runVaultWatchBatches(root, watchVaultEvents(root), operations, options);
}
