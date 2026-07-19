import { makeVaultCloudClient } from "@t3tools/vault-sync/client";
import { pullVault, pushVault } from "@t3tools/vault-sync/sync";
import { readSyncState } from "@t3tools/vault-sync/syncState";
import { runVaultWatch } from "@t3tools/vault-sync/watch";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerConfig from "./config.ts";

export const VAULT_WATCH_RESTART_BACKOFF = Duration.seconds(1);

/** Restarts an unexpectedly completed or failed watch until its enclosing scope closes. */
export const superviseVaultWatch = Effect.fn("VaultReplica.superviseVaultWatch")(function* <
  Success,
  Error,
  Requirements,
>(
  watch: () => Effect.Effect<Success, Error, Requirements>,
  restartBackoff: Duration.Input = VAULT_WATCH_RESTART_BACKOFF,
) {
  while (true) {
    const exit = yield* Effect.exit(watch());
    if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
      return yield* Effect.interrupt;
    }

    if (Exit.isFailure(exit)) {
      yield* Effect.logError("Vault replica watch terminated; restarting", {
        cause: Cause.squash(exit.cause),
        restartBackoffMs: Duration.toMillis(restartBackoff),
      });
    } else {
      yield* Effect.logError("Vault replica watch completed unexpectedly; restarting", {
        restartBackoffMs: Duration.toMillis(restartBackoff),
      });
    }
    yield* Effect.sleep(restartBackoff);
  }
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const replica = config.vaultReplica;
    if (replica === undefined) return;

    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(replica.root, { recursive: true });

    const httpClient = yield* HttpClient.HttpClient;
    const client = makeVaultCloudClient({
      baseUrl: replica.baseUrl,
      token: replica.token,
      httpClient,
    });
    const crypto = yield* Crypto.Crypto;
    const makeVersion = Effect.fn("VaultReplica.makeSyncVersion")(function* () {
      return {
        revision: yield* crypto.randomUUIDv7,
        generatedAt: DateTime.formatIso(yield* DateTime.now),
      };
    });
    const watch = () =>
      runVaultWatch(
        replica.root,
        {
          push: () =>
            Effect.gen(function* () {
              const version = yield* makeVersion();
              const result = yield* pushVault({
                root: replica.root,
                vaultId: replica.vaultId,
                client,
                ...version,
              });
              return { revision: result.manifest.revision };
            }),
          pull: () =>
            pullVault({ root: replica.root, vaultId: replica.vaultId, client }).pipe(
              Effect.map((result) => ({ revision: result.manifest.revision })),
            ),
        },
        {
          revisions: {
            remote: () =>
              client
                .getManifest(replica.vaultId)
                .pipe(Effect.map((remote) => remote?.manifest.revision ?? null)),
            local: () =>
              readSyncState(replica.root).pipe(
                Effect.map((state) => state?.manifest.revision ?? null),
              ),
          },
        },
      );

    yield* Effect.logInfo("Starting supervised vault replica", {
      root: replica.root,
      vaultId: replica.vaultId,
      baseUrl: replica.baseUrl,
    });
    yield* superviseVaultWatch(watch).pipe(Effect.forkScoped);
  }),
);
