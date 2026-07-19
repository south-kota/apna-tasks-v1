#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeProcess from "node:process";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { makeVaultCloudClient } from "./client.ts";
import { pullVault, pushVault, statusVault } from "./sync.ts";
import { isSyncStatusStale, syncErrorMessage, updateSyncStatus } from "./syncStatus.ts";
import { runVaultWatch } from "./watch.ts";

export class SyncCliUsageError extends Schema.TaggedErrorClass<SyncCliUsageError>()(
  "SyncCliUsageError",
  {},
) {
  override get message(): string {
    return [
      "Usage: vault-sync <push|pull|status|watch> <vault-directory> --vault-id <id> [--force] [--no-prune]",
      "Environment: APNA_VAULT_URL, APNA_VAULT_TOKEN",
    ].join("\n");
  }
}

export class SyncCliConflictError extends Schema.TaggedErrorClass<SyncCliConflictError>()(
  "SyncCliConflictError",
  { count: Schema.Number },
) {
  override get message(): string {
    return `${this.count} local edit(s) lost to remote versions and were preserved under .apnatasks/conflicts.`;
  }
}

function valueAfter(args: ReadonlyArray<string>, flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

const main = Effect.gen(function* () {
  const args = NodeProcess.argv.slice(2);
  const command = args[0];
  const root = args[1];
  const vaultId = valueAfter(args, "--vault-id");
  if (
    (command !== "push" && command !== "pull" && command !== "status" && command !== "watch") ||
    root === undefined ||
    vaultId === undefined
  ) {
    return yield* new SyncCliUsageError();
  }

  const baseUrl = yield* Config.string("APNA_VAULT_URL");
  const token = yield* Config.redacted("APNA_VAULT_TOKEN");
  const httpClient = yield* HttpClient.HttpClient;
  const client = makeVaultCloudClient({ baseUrl, token, httpClient });
  const crypto = yield* Crypto.Crypto;
  const makeVersion = Effect.fn("makeSyncVersion")(function* () {
    const revision = yield* crypto.randomUUIDv7;
    const generatedAt = DateTime.formatIso(yield* DateTime.now);
    return { revision, generatedAt };
  });

  if (command === "watch") {
    yield* runVaultWatch(root, {
      push: () =>
        Effect.gen(function* () {
          const version = yield* makeVersion();
          const result = yield* pushVault({ root, vaultId, client, ...version });
          return { revision: result.manifest.revision };
        }),
      pull: () =>
        pullVault({ root, vaultId, client }).pipe(
          Effect.map((result) => ({ revision: result.manifest.revision })),
        ),
    });
    return;
  }

  const { revision, generatedAt } = yield* makeVersion();

  if (command === "push") {
    yield* updateSyncStatus(root, { state: "pushing" });
    const result = yield* pushVault({
      root,
      vaultId,
      client,
      revision,
      generatedAt,
      force: args.includes("--force"),
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* updateSyncStatus(root, {
            state: "error",
            lastError: syncErrorMessage(Cause.squash(cause)),
          });
          return yield* Effect.failCause(cause);
        }),
      ),
    );
    yield* updateSyncStatus(root, {
      state: "clean",
      lastPushedRevision: result.manifest.revision,
      successful: true,
    });
    yield* Console.log(
      `Pushed ${result.manifest.files.length} files (${result.uploaded} new objects), manifest ${result.etag}.`,
    );
    return;
  }

  if (command === "status") {
    const status = yield* statusVault({ root, vaultId, client, revision, generatedAt });
    if (status.syncStatus === null) {
      yield* Console.log("Sync lifecycle status is unavailable.");
    } else {
      const lifecycle = status.syncStatus;
      const stale = isSyncStatusStale(lifecycle, yield* Clock.currentTimeMillis) ? ", stale" : "";
      yield* Console.log(
        `Sync lifecycle ${lifecycle.state}${stale}; updated ${lifecycle.updatedAt}.`,
      );
      if (lifecycle.pendingPaths.length > 0) {
        yield* Console.log(`  pending     ${lifecycle.pendingPaths.join(", ")}`);
      }
      if (lifecycle.lastError !== null) yield* Console.log(`  last-error  ${lifecycle.lastError}`);
    }
    if (status.remote === null) {
      yield* Console.log("Remote vault does not exist yet. Run push to create it.");
    } else {
      yield* Console.log(`Remote revision ${status.remote.revision} (${status.remote.etag}).`);
    }
    for (const path of status.localOnly) yield* Console.log(`  local-only  ${path}`);
    for (const path of status.remoteOnly) yield* Console.log(`  remote-only ${path}`);
    for (const path of status.modified) yield* Console.log(`  modified    ${path}`);
    yield* Console.log(status.inSync ? "In sync." : "Out of sync.");
    return;
  }

  yield* updateSyncStatus(root, { state: "pulling" });
  const pulled = yield* pullVault({
    root,
    vaultId,
    client,
    prune: !args.includes("--no-prune"),
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* updateSyncStatus(root, {
          state: "error",
          lastError: syncErrorMessage(Cause.squash(cause)),
        });
        return yield* Effect.failCause(cause);
      }),
    ),
  );
  const liveStatus = yield* statusVault({ root, vaultId, client, revision, generatedAt });
  const pendingPaths = [
    ...liveStatus.localOnly,
    ...liveStatus.remoteOnly,
    ...liveStatus.modified,
  ].toSorted();
  yield* updateSyncStatus(root, {
    state: liveStatus.inSync ? "clean" : "pending",
    pendingPaths,
    lastPulledRevision: pulled.manifest.revision,
    successful: liveStatus.inSync,
  });
  const { result } = pulled;
  yield* Console.log(
    `Pulled ${pulled.manifest.files.length} files: ${result.created.length} created, ` +
      `${result.updated.length} updated, ${result.unchanged.length} unchanged, ` +
      `${result.deleted.length} deleted, ${result.conflicts.length} conflicts, ` +
      `${result.keptModified.length} kept despite remote deletion.`,
  );
  if (result.conflicts.length > 0) {
    return yield* new SyncCliConflictError({ count: result.conflicts.length });
  }
});

if (import.meta.main) {
  main.pipe(
    Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
    NodeRuntime.runMain({
      teardown: (exit, onExit) => {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return onExit(0);
        Runtime.defaultTeardown(exit, onExit);
      },
    }),
  );
}
