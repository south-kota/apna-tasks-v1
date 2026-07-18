/**
 * CLI entry for the NotePlan bridge.
 *
 *   pnpm --filter @t3tools/noteplan-bridge bridge init          # write a disabled sample config
 *   pnpm --filter @t3tools/noteplan-bridge bridge sync --dry-run # preview (allowed while disabled)
 *   pnpm --filter @t3tools/noteplan-bridge bridge sync           # one pass (requires enabled: true)
 *   pnpm --filter @t3tools/noteplan-bridge bridge watch          # continuous (requires enabled: true)
 *
 * The bridge is disabled by default; `sync`/`watch` refuse to run until Kota
 * sets `enabled: true` in the config file.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import {
  defaultConfigPath,
  loadBridgeConfig,
  sampleConfigJson,
  toMirrorConfig,
} from "./bridgeConfig.ts";
import { syncPass, watchLoop, type SyncPassResult } from "./mirror.ts";

const configFlag = Flag.string("config").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Path to the bridge config JSON"),
  Flag.withDefault(defaultConfigPath()),
);

const bridge = Command.make("noteplan-bridge").pipe(
  Command.withSharedFlags({ config: configFlag }),
  Command.withDescription("Mirror vault markdown into NotePlan's folders (disabled by default)"),
);

const reportPass = (result: SyncPassResult, dryRun: boolean) =>
  Effect.gen(function* () {
    const verb = dryRun ? "would change" : "changed";
    yield* Console.log(
      `Sync pass: ${result.results.length} pair(s) ${verb}, ${result.writes} write(s).`,
    );
    for (const item of result.results) {
      yield* Console.log(
        `  ${item.action} ${item.key}${item.detail === "" ? "" : ` (${item.detail})`}`,
      );
    }
  });

export class BridgeDisabledError extends Schema.TaggedErrorClass<BridgeDisabledError>()(
  "BridgeDisabledError",
  {
    configPath: Schema.String,
  },
) {
  override get message(): string {
    return `NotePlan bridge is disabled; set "enabled": true in ${this.configPath} to run it.`;
  }
}

const requireEnabled = Effect.fn("requireEnabled")(function* (configPath: string, dryRun: boolean) {
  const config = yield* loadBridgeConfig(configPath);
  if (!config.enabled && !dryRun) {
    yield* Console.error(
      `NotePlan bridge is disabled. Review with \`sync --dry-run\`, then set "enabled": true in ${configPath}.`,
    );
    return yield* new BridgeDisabledError({ configPath });
  }
  return config;
});

const init = Command.make("init", {}, () =>
  Effect.gen(function* () {
    const { config } = yield* bridge;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (yield* fs.exists(config)) {
      yield* Console.log(`Config already exists at ${config}; not overwriting.`);
      return;
    }
    yield* fs.makeDirectory(path.dirname(config), { recursive: true });
    yield* fs.writeFileString(config, sampleConfigJson());
    yield* Console.log(
      `Wrote disabled sample config to ${config}. Review, then set "enabled": true.`,
    );
  }),
).pipe(Command.withDescription("Write a disabled sample config file"));

const sync = Command.make(
  "sync",
  {
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Report planned actions without writing anything"),
    ),
  },
  Effect.fn(function* ({ dryRun }) {
    const { config: configPath } = yield* bridge;
    const config = yield* requireEnabled(configPath, dryRun);
    const result = yield* syncPass(toMirrorConfig(config), { dryRun });
    yield* reportPass(result, dryRun);
  }),
).pipe(Command.withDescription("Run one bidirectional sync pass"));

const watch = Command.make("watch", {}, () =>
  Effect.gen(function* () {
    const { config: configPath } = yield* bridge;
    const config = yield* requireEnabled(configPath, false);
    yield* Console.log("NotePlan bridge watching for changes (ctrl-c to stop)...");
    yield* watchLoop(toMirrorConfig(config), {
      onPass: (result) => (result.results.length === 0 ? Effect.void : reportPass(result, false)),
    });
  }),
).pipe(Command.withDescription("Watch both trees and sync continuously"));

bridge.pipe(
  Command.withSubcommands([init, sync, watch]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
