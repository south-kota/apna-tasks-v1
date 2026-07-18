/**
 * Debounced recursive vault watching. Emits batches of vault-relative file
 * events: after a change arrives, the watcher waits for a quiet period and
 * flushes everything seen so far as one batch (last event per path wins).
 * Ignore rules (node_modules, .git, .obsidian, .jbom, config globs, ...)
 * are applied before debouncing.
 *
 * @module Watcher
 */
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type { PlatformError } from "effect/PlatformError";

import { makeIgnoreMatcher } from "./Config.ts";
import type { VaultFileEvent, VaultFileEventKind } from "./Model.ts";

export interface WatchOptions {
  /** Quiet period before a batch is flushed. Default 250ms. */
  readonly debounce?: Duration.Input;
  /** Extra ignore globs (vault-relative), additive to the defaults. */
  readonly ignore?: ReadonlyArray<string>;
  /** Only emit paths matching this predicate. Defaults to Markdown + jbom.json. */
  readonly filter?: (relativePath: string) => boolean;
}

const defaultFilter = (relativePath: string): boolean =>
  relativePath.toLowerCase().endsWith(".md") || relativePath === "jbom.json";

const toPosix = (value: string): string => value.split("\\").join("/");

const mergeKinds = (
  previous: VaultFileEventKind | undefined,
  next: VaultFileEventKind,
): VaultFileEventKind => {
  if (previous === undefined) return next;
  if (next === "removed") return "removed";
  if (previous === "created" && next === "updated") return "created";
  if (previous === "removed" && next === "created") return "updated";
  return next;
};

/**
 * Watches a vault root recursively, emitting debounced batches of events.
 * Each batch contains at most one event per path, sorted by path.
 */
export const watchVault = (
  vaultRoot: string,
  options?: WatchOptions,
): Stream.Stream<ReadonlyArray<VaultFileEvent>, PlatformError, FileSystem.FileSystem> => {
  const debounce: Duration.Input = options?.debounce ?? Duration.millis(250);
  const filter = options?.filter ?? defaultFilter;
  const isIgnored = makeIgnoreMatcher(options?.ignore ?? []);

  // The platform watcher's Create/Remove classification is unreliable for
  // nested paths (it stats paths relative to the process cwd), so events are
  // reclassified here by checking existence against the vault root: an
  // existing path is an upsert ("updated"), a missing one is a removal.
  const raw: Stream.Stream<VaultFileEvent, PlatformError, FileSystem.FileSystem> = Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return fs.watch(vaultRoot).pipe(
        Stream.filterMap((event) => {
          const relative = toPosix(event.path);
          if (relative === "" || relative.startsWith("..")) return Result.failVoid;
          if (isIgnored(relative) || !filter(relative)) return Result.failVoid;
          return Result.succeed(relative);
        }),
        Stream.mapEffect((relative) =>
          fs.exists(`${vaultRoot}/${relative}`).pipe(
            Effect.orElseSucceed(() => false),
            Effect.map(
              (exists): VaultFileEvent => ({
                kind: exists ? "updated" : "removed",
                path: relative,
              }),
            ),
          ),
        ),
      );
    }),
  );

  return Stream.callback<ReadonlyArray<VaultFileEvent>, PlatformError, FileSystem.FileSystem>(
    (output) =>
      Effect.gen(function* () {
        const inbox = yield* Queue.make<VaultFileEvent, PlatformError | Cause.Done>();
        yield* raw.pipe(
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
            const pending = new Map<string, VaultFileEventKind>();
            pending.set(first.path, mergeKinds(undefined, first.kind));
            while (true) {
              const next = yield* Queue.take(inbox).pipe(Effect.timeoutOption(debounce));
              if (Option.isNone(next)) break;
              pending.set(
                next.value.path,
                mergeKinds(pending.get(next.value.path), next.value.kind),
              );
            }
            const batch = [...pending.entries()]
              .map(([path, kind]): VaultFileEvent => ({ path, kind }))
              .sort((left, right) => (left.path < right.path ? -1 : 1));
            yield* Queue.offer(output, batch);
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
};
