import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ManifestPreconditionError } from "./client.ts";
import { RemoteManifestChangedError } from "./sync.ts";
import { syncErrorMessage, updateSyncStatus } from "./syncStatus.ts";
import { isIgnoredVaultPath } from "./vault.ts";

export const WATCH_DEBOUNCE = Duration.seconds(2);

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

function runWatchBatch<PushError, PullError, Requirements>(
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

/** Runs already-batched watch events serially. Exported for deterministic daemon tests. */
export function runVaultWatchBatches<
  BatchError,
  PushError,
  PullError,
  BatchRequirements,
  Requirements,
>(
  root: string,
  batches: Stream.Stream<ReadonlyArray<string>, BatchError, BatchRequirements>,
  operations: WatchSyncOperations<PushError, PullError, Requirements>,
) {
  return batches.pipe(Stream.runForEach((paths) => runWatchBatch(root, paths, operations)));
}

/** Runs watch batches serially; cycle failures are logged and never end the daemon. */
export function runVaultWatch<PushError, PullError, Requirements>(
  root: string,
  operations: WatchSyncOperations<PushError, PullError, Requirements>,
): Effect.Effect<
  void,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Requirements
> {
  return runVaultWatchBatches(root, watchVaultEvents(root), operations);
}
