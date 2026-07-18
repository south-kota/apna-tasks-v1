/**
 * The composed JBOM engine: config + SQLite index + debounced watcher.
 *
 * On startup it rebuilds the index from the vault (cheap, and the index is a
 * derived artifact anyway), then keeps it fresh from watcher batches. Changes
 * to `jbom.json` trigger a config reload is left to the host — the engine
 * treats config as fixed for its lifetime; restart the layer to pick up
 * config changes.
 *
 * @module Engine
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { type JbomConfigError, loadConfig, type ResolvedConfig } from "./Config.ts";
import { JbomIndex, type JbomIndexError, makeIndex } from "./Index.ts";
import type { VaultFileEvent } from "./Model.ts";
import { watchVault } from "./Watcher.ts";

export class JbomEngine extends Context.Service<
  JbomEngine,
  {
    readonly vaultRoot: string;
    readonly config: ResolvedConfig;
    readonly index: JbomIndex["Service"];
    /** Batches of vault changes that have already been applied to the index. */
    readonly changes: Stream.Stream<ReadonlyArray<VaultFileEvent>>;
  }
>()("@t3tools/jbom/Engine/JbomEngine") {
  static readonly layer = (options: {
    readonly vaultRoot: string;
    /** Defaults to `<vaultRoot>/<runtimeDir>/index.sqlite`. */
    readonly dbPath?: string | undefined;
    /** Disable watching (index is still rebuilt once). */
    readonly watch?: boolean;
  }): Layer.Layer<
    JbomEngine,
    JbomConfigError | JbomIndexError,
    FileSystem.FileSystem | Path.Path
  > =>
    Layer.effect(
      JbomEngine,
      Effect.gen(function* () {
        const config = yield* loadConfig(options.vaultRoot);
        const index = yield* makeIndex({
          vaultRoot: options.vaultRoot,
          config,
          dbPath: options.dbPath,
        });

        yield* index.rebuild();

        const hub = yield* PubSub.unbounded<ReadonlyArray<VaultFileEvent>>();

        if (options.watch !== false) {
          yield* watchVault(options.vaultRoot, { ignore: config.ignore }).pipe(
            Stream.runForEach((batch) =>
              index.applyEvents(batch).pipe(
                Effect.andThen(PubSub.publish(hub, batch)),
                Effect.catchCause((cause) => Effect.logWarning("jbom watch batch failed", cause)),
              ),
            ),
            Effect.catchCause((cause) => Effect.logWarning("jbom watcher stopped", cause)),
            Effect.forkScoped,
          );
        }

        return JbomEngine.of({
          vaultRoot: options.vaultRoot,
          config,
          index,
          changes: Stream.fromPubSub(hub),
        });
      }),
    );
}
