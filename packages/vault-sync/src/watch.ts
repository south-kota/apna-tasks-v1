import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ManifestPreconditionError } from "./client.ts";
import { RemoteManifestChangedError } from "./sync.ts";
import { isIgnoredVaultPath } from "./vault.ts";

export const WATCH_DEBOUNCE = Duration.seconds(2);

export interface WatchPushResult {
  readonly revision: string;
}

export interface WatchSyncOperations<PushError, PullError, Requirements> {
  readonly push: () => Effect.Effect<WatchPushResult, PushError, Requirements>;
  readonly pull: () => Effect.Effect<unknown, PullError, Requirements>;
}

export interface WatchCycleResult extends WatchPushResult {
  readonly retried: boolean;
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
    Effect.map((result) => ({ ...result, retried: false })),
    Effect.catch((error) => {
      if (!isStalePushError(error)) return Effect.fail(error);
      return Effect.gen(function* () {
        yield* operations.pull();
        const result = yield* operations.push();
        return { ...result, retried: true };
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

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/gu, " ").trim().slice(0, 500);
}

/** Runs watch batches serially; cycle failures are logged and never end the daemon. */
export function runVaultWatch<PushError, PullError, Requirements>(
  root: string,
  operations: WatchSyncOperations<PushError, PullError, Requirements>,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Requirements> {
  return watchVaultEvents(root).pipe(
    Stream.runForEach((paths) =>
      runWatchCycle(operations).pipe(
        Effect.tap((result) =>
          Console.log(
            `${paths.length} files changed; pushed revision ${result.revision}${
              result.retried ? " after stale pull" : ""
            }.`,
          ),
        ),
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Console.error(
                `${paths.length} files changed; push failed: ${errorMessage(Cause.squash(cause))}`,
              ),
        ),
      ),
    ),
  );
}
