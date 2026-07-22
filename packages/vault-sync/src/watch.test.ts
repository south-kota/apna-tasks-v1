import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ManifestPreconditionError, VaultCloudRequestError } from "./client.ts";
import { RemoteManifestChangedError } from "./sync.ts";
import { SYNC_STATE_SCHEMA, writeSyncState } from "./syncState.ts";
import { readSyncStatus, type VaultSyncStatus } from "./syncStatus.ts";
import { scanVault } from "./vault.ts";
import { loadVaultIgnore } from "./vaultIgnore.ts";
import { debounceWatchEvents, runVaultWatchBatches, runWatchCycle } from "./watch.ts";

describe("vault watch", () => {
  it.effect("debounces rapid events into sorted unique batches after a quiet period", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.make<string>();
        const batches = yield* Queue.make<ReadonlyArray<string>>();
        const fiber = yield* debounceWatchEvents(Stream.fromQueue(events)).pipe(
          Stream.runForEach((batch) => Queue.offer(batches, batch)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        yield* Queue.offer(events, "notes/b.md");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Queue.offer(events, "notes/a.md");
        yield* Queue.offer(events, "notes/b.md");
        yield* Effect.yieldNow;

        yield* TestClock.adjust("1999 millis");
        assert.isTrue(Option.isNone(yield* Queue.poll(batches)));
        yield* TestClock.adjust("1 milli");
        assert.deepEqual(yield* Queue.take(batches), ["notes/a.md", "notes/b.md"]);

        yield* Queue.offer(events, "later.md");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("2 seconds");
        assert.deepEqual(yield* Queue.take(batches), ["later.md"]);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("pushes once when the remote is current", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const result = yield* runWatchCycle({
        push: () =>
          Effect.sync(() => {
            calls.push("push");
            return { revision: "rev-1" };
          }),
        pull: () =>
          Effect.sync(() => {
            calls.push("pull");
            return { revision: "pulled-1" };
          }),
      });

      assert.deepEqual(calls, ["push"]);
      assert.deepEqual(result, { revision: "rev-1", retried: false, pulledRevision: null });
    }),
  );

  it.effect("pulls and retries once after a stale preflight rejection", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let pushes = 0;
      const result = yield* runWatchCycle({
        push: () =>
          Effect.suspend(() => {
            calls.push("push");
            pushes += 1;
            return pushes === 1
              ? Effect.fail(new RemoteManifestChangedError({ vaultId: "test" }))
              : Effect.succeed({ revision: "rev-2" });
          }),
        pull: () =>
          Effect.sync(() => {
            calls.push("pull");
            return { revision: "remote-2" };
          }),
      });

      assert.deepEqual(calls, ["push", "pull", "push"]);
      assert.deepEqual(result, {
        revision: "rev-2",
        retried: true,
        pulledRevision: "remote-2",
      });
    }),
  );

  it.effect("retries a compare-and-set rejection only once", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const failure = yield* runWatchCycle({
        push: () => {
          calls.push("push");
          return Effect.fail(new ManifestPreconditionError({ vaultId: "test" }));
        },
        pull: () =>
          Effect.sync(() => {
            calls.push("pull");
            return { revision: "remote-2" };
          }),
      }).pipe(Effect.flip);

      assert.deepEqual(calls, ["push", "pull", "push"]);
      assert.instanceOf(failure, ManifestPreconditionError);
    }),
  );

  it.effect("does not pull or retry an unrelated push failure", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const failure = yield* runWatchCycle({
        push: () => {
          calls.push("push");
          return Effect.fail(new VaultCloudRequestError({ operation: "upload object" }));
        },
        pull: () =>
          Effect.sync(() => {
            calls.push("pull");
            return { revision: "remote-2" };
          }),
      }).pipe(Effect.flip);

      assert.deepEqual(calls, ["push"]);
      assert.instanceOf(failure, VaultCloudRequestError);
    }),
  );
});

it.layer(NodeServices.layer)("vault watch status lifecycle", (it) => {
  it.effect("does not run a cycle or mark pending for ignored paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-ignore-" });
      yield* fs.writeFileString(path.join(root, ".vaultignore"), "repo\n");
      let pushes = 0;

      yield* runVaultWatchBatches(root, Stream.fromIterable([["projects/repo/note.md"]]), {
        push: () => {
          pushes += 1;
          return Effect.succeed({ revision: "unexpected" });
        },
        pull: () => Effect.succeed({ revision: "unexpected" }),
      });

      assert.equal(pushes, 0);
      assert.isNull(yield* readSyncStatus(root));
    }),
  );

  it.effect("records the pulled and pushed revisions after a stale-remote retry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-retry-" });
      const calls: Array<string> = [];
      let pushes = 0;

      yield* runVaultWatchBatches(root, Stream.fromIterable([["note.md"]]), {
        push: () => {
          calls.push("push");
          pushes += 1;
          return pushes === 1
            ? Effect.fail(new RemoteManifestChangedError({ vaultId: "test" }))
            : Effect.succeed({ revision: "local-3" });
        },
        pull: () => {
          calls.push("pull");
          return Effect.succeed({ revision: "remote-2" });
        },
      });

      assert.deepEqual(calls, ["push", "pull", "push"]);
      const status = yield* readSyncStatus(root);
      assert.equal(status?.state, "clean");
      assert.equal(status?.lastPulledRevision, "remote-2");
      assert.equal(status?.lastPushedRevision, "local-3");
    }),
  );

  it.effect("records a failed cycle and continues to the next batch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-status-" });
      let pushes = 0;
      let failedStatus: VaultSyncStatus | null = null;
      const batches = Stream.fromIterable<ReadonlyArray<string>>([["first.md"]]).pipe(
        Stream.concat(
          Stream.fromEffect(
            Effect.gen(function* () {
              failedStatus = yield* readSyncStatus(root);
              return ["second.md"];
            }),
          ),
        ),
      );

      yield* runVaultWatchBatches(root, batches, {
        push: () => {
          pushes += 1;
          return pushes === 1
            ? Effect.fail(new VaultCloudRequestError({ operation: "upload object" }))
            : Effect.succeed({ revision: "revision-2" });
        },
        pull: () => Effect.succeed({ revision: "remote-1" }),
      });

      assert.equal(pushes, 2);
      const capturedStatus = failedStatus as VaultSyncStatus | null;
      assert.equal(capturedStatus?.state, "error");
      assert.include(capturedStatus?.lastError ?? "", "upload object");
      const finalStatus = yield* readSyncStatus(root);
      assert.equal(finalStatus?.state, "clean");
      assert.equal(finalStatus?.lastPushedRevision, "revision-2");
    }),
  );

  it.effect("reconciles missing and stale local state before processing batches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-startup-" });

      for (const initialLocalRevision of [null, "remote-old"] as const) {
        const calls: Array<string> = [];
        let localRevision: string | null = initialLocalRevision;
        yield* runVaultWatchBatches(
          root,
          Stream.fromIterable<ReadonlyArray<string>>([]),
          {
            push: () => Effect.succeed({ revision: "unexpected" }),
            pull: () =>
              Effect.sync(() => {
                calls.push("pull");
                localRevision = "remote-current";
                return { revision: "remote-current" };
              }),
          },
          {
            pollInterval: 0,
            revisions: {
              remote: () => Effect.succeed("remote-current"),
              local: () => Effect.succeed(localRevision),
            },
          },
        );
        assert.deepEqual(calls, ["pull"]);
      }
    }),
  );

  it.effect("pulls a fresh replica before its first local batch can push", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-fresh-" });
      const calls: Array<string> = [];
      let localRevision: string | null = null;

      yield* runVaultWatchBatches(
        root,
        Stream.fromIterable([["note.md"]]),
        {
          push: () =>
            Effect.sync(() => {
              calls.push("push");
              return { revision: "local-after-pull" };
            }),
          pull: () =>
            Effect.sync(() => {
              calls.push("pull");
              localRevision = "remote-1";
              return { revision: "remote-1" };
            }),
        },
        {
          pollInterval: 0,
          revisions: {
            remote: () =>
              Effect.sync(() => {
                calls.push("remote");
                return "remote-1";
              }),
            local: () =>
              Effect.sync(() => {
                calls.push("local");
                return localRevision;
              }),
          },
        },
      );

      assert.deepEqual(calls, ["remote", "local", "pull", "push"]);
    }),
  );

  it.effect("flushes offline local changes at startup before any events", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-offline-" });
      // No sync state exists, so this file is offline backlog from before the
      // daemon started — no FS event will ever fire for it.
      yield* fs.writeFileString(path.join(root, "offline.md"), "edited while down\n");

      const calls: Array<string> = [];
      yield* runVaultWatchBatches(
        root,
        Stream.fromIterable<ReadonlyArray<string>>([]),
        {
          push: () =>
            Effect.sync(() => {
              calls.push("push");
              return { revision: "flushed-1" };
            }),
          pull: () => Effect.succeed({ revision: "unexpected" }),
        },
        {
          pollInterval: 0,
          revisions: {
            remote: () => Effect.succeed(null),
            local: () => Effect.succeed(null),
          },
        },
      );

      assert.deepEqual(calls, ["push"]);
      const status = yield* readSyncStatus(root);
      assert.equal(status?.state, "clean");
      assert.equal(status?.lastPushedRevision, "flushed-1");
    }),
  );

  it.effect("skips the startup flush when the tree matches sync state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-clean-" });
      yield* fs.writeFileString(path.join(root, "synced.md"), "already pushed\n");
      const manifest = yield* scanVault(
        root,
        { vaultId: "clean-vault", revision: "rev-1", generatedAt: "2026-07-22T00:00:00.000Z" },
        yield* loadVaultIgnore(root),
      );
      yield* writeSyncState(root, { schema: SYNC_STATE_SCHEMA, etag: "etag-1", manifest });

      const calls: Array<string> = [];
      yield* runVaultWatchBatches(
        root,
        Stream.fromIterable<ReadonlyArray<string>>([]),
        {
          push: () =>
            Effect.sync(() => {
              calls.push("push");
              return { revision: "unexpected" };
            }),
          pull: () => Effect.succeed({ revision: "unexpected" }),
        },
        {
          pollInterval: 0,
          revisions: {
            remote: () => Effect.succeed("rev-1"),
            local: () => Effect.succeed("rev-1"),
          },
        },
      );

      assert.deepEqual(calls, []);
    }),
  );

  it.effect("does not let a failed startup pull expose a fresh replica to pushes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-startup-fail-" });
        const batches = yield* Queue.make<ReadonlyArray<string>>();
        const watchStarted = yield* Deferred.make<void>();
        const batchStream = Stream.fromEffect(Deferred.succeed(watchStarted, undefined)).pipe(
          Stream.drain,
          Stream.concat(Stream.fromQueue(batches)),
        );
        const pushed = yield* Deferred.make<void>();
        let allowPull = false;
        let localRevision: string | null = null;
        let pullAttempts = 0;
        const pullAttempted = yield* Queue.make<void>();
        let pushes = 0;

        const fiber = yield* runVaultWatchBatches(
          root,
          batchStream,
          {
            push: () =>
              Effect.gen(function* () {
                pushes += 1;
                yield* Deferred.succeed(pushed, undefined);
                return { revision: "local-2" };
              }),
            pull: () =>
              Effect.gen(function* () {
                pullAttempts += 1;
                yield* Queue.offer(pullAttempted, undefined);
                if (!allowPull) {
                  return yield* new VaultCloudRequestError({ operation: "download object" });
                }
                localRevision = "remote-1";
                return { revision: "remote-1" };
              }),
          },
          {
            pollInterval: "1 second",
            revisions: {
              remote: () => Effect.succeed("remote-1"),
              local: () => Effect.succeed(localRevision),
            },
          },
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(watchStarted);
        yield* Queue.take(pullAttempted);
        yield* Queue.offer(batches, ["note.md"]);
        yield* Queue.take(pullAttempted);

        assert.equal(pushes, 0);
        let failedStatus: VaultSyncStatus | null = null;
        while (failedStatus?.state !== "error") {
          yield* Effect.yieldNow;
          failedStatus = yield* readSyncStatus(root);
        }

        allowPull = true;
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(pushed);
        assert.equal(pushes, 1);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("polls revisions, skips unchanged remotes, and pulls changed remotes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-poll-" });
        const batches = yield* Queue.make<ReadonlyArray<string>>();
        let remoteRevision = "remote-1";
        let localRevision = "remote-1";
        let checks = 0;
        let pulls = 0;
        const pullCompleted = yield* Queue.make<string>();

        const fiber = yield* runVaultWatchBatches(
          root,
          Stream.fromQueue(batches),
          {
            push: () => Effect.succeed({ revision: "local" }),
            pull: () =>
              Effect.gen(function* () {
                pulls += 1;
                localRevision = remoteRevision;
                yield* Queue.offer(pullCompleted, remoteRevision);
                return { revision: remoteRevision };
              }),
          },
          {
            pollInterval: "1 second",
            revisions: {
              remote: () =>
                Effect.sync(() => {
                  checks += 1;
                  return remoteRevision;
                }),
              local: () => Effect.succeed(localRevision),
            },
          },
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        assert.equal(checks, 1);
        yield* TestClock.adjust("1 second");
        assert.equal(checks, 2);
        assert.equal(pulls, 0);

        remoteRevision = "remote-2";
        yield* TestClock.adjust("1 second");
        assert.equal(yield* Queue.take(pullCompleted), "remote-2");
        assert.equal(checks, 3);
        assert.equal(pulls, 1);
        let status: VaultSyncStatus | null = null;
        while (status?.lastPulledRevision !== "remote-2") {
          yield* Effect.yieldNow;
          status = yield* readSyncStatus(root);
        }
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("shows pulling during a poll pull and returns to clean", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-poll-status-" });
        const batches = yield* Queue.make<ReadonlyArray<string>>();
        const pullStarted = yield* Deferred.make<void>();
        const finishPull = yield* Deferred.make<void>();
        let remoteRevision = "remote-1";
        let localRevision = "remote-1";

        const fiber = yield* runVaultWatchBatches(
          root,
          Stream.fromQueue(batches),
          {
            push: () => Effect.succeed({ revision: "local" }),
            pull: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(pullStarted, undefined);
                yield* Deferred.await(finishPull);
                localRevision = remoteRevision;
                return { revision: remoteRevision };
              }),
          },
          {
            pollInterval: "1 second",
            revisions: {
              remote: () => Effect.succeed(remoteRevision),
              local: () => Effect.succeed(localRevision),
            },
          },
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        remoteRevision = "remote-2";
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(pullStarted);
        assert.equal((yield* readSyncStatus(root))?.state, "pulling");

        yield* Deferred.succeed(finishPull, undefined);
        for (let attempt = 0; attempt < 10; attempt += 1) {
          yield* Effect.yieldNow;
          if ((yield* readSyncStatus(root))?.state === "clean") break;
        }
        const status = yield* readSyncStatus(root);
        assert.equal(status?.state, "clean");
        assert.equal(status?.lastPulledRevision, "remote-2");
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("serializes a due poll behind an in-flight push batch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-serialize-" });
        const batches = yield* Queue.make<ReadonlyArray<string>>();
        const pushStarted = yield* Deferred.make<void>();
        const finishPush = yield* Deferred.make<void>();
        const remoteChecked = yield* Queue.make<void>();
        let remoteChecks = 0;

        const fiber = yield* runVaultWatchBatches(
          root,
          Stream.fromQueue(batches),
          {
            push: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(pushStarted, undefined);
                yield* Deferred.await(finishPush);
                return { revision: "local-2" };
              }),
            pull: () => Effect.succeed({ revision: "remote-1" }),
          },
          {
            pollInterval: "1 second",
            revisions: {
              remote: () =>
                Effect.gen(function* () {
                  remoteChecks += 1;
                  yield* Queue.offer(remoteChecked, undefined);
                  return "remote-1";
                }),
              local: () => Effect.succeed("remote-1"),
            },
          },
        ).pipe(Effect.forkScoped);
        yield* Queue.take(remoteChecked);
        yield* Queue.offer(batches, ["note.md"]);
        yield* Deferred.await(pushStarted);

        yield* TestClock.adjust("1 second");
        assert.equal(remoteChecks, 1);

        yield* Deferred.succeed(finishPush, undefined);
        yield* Queue.take(remoteChecked);
        assert.equal(remoteChecks, 2);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("records a failed poll and continues polling until it recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-poll-fail-" });
        const batches = yield* Queue.make<ReadonlyArray<string>>();
        const watchStarted = yield* Deferred.make<void>();
        const batchStream = Stream.fromEffect(Deferred.succeed(watchStarted, undefined)).pipe(
          Stream.drain,
          Stream.concat(Stream.fromQueue(batches)),
        );
        let remoteRevision = "remote-1";
        let localRevision = "remote-1";
        let attempts = 0;
        const pullAttempted = yield* Queue.make<void>();
        const pushed = yield* Deferred.make<void>();

        const fiber = yield* runVaultWatchBatches(
          root,
          batchStream,
          {
            push: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(pushed, undefined);
                return { revision: "local" };
              }),
            pull: () =>
              Effect.gen(function* () {
                attempts += 1;
                yield* Queue.offer(pullAttempted, undefined);
                if (attempts === 1) {
                  return yield* new VaultCloudRequestError({ operation: "download object" });
                }
                localRevision = remoteRevision;
                return { revision: remoteRevision };
              }),
          },
          {
            pollInterval: "1 second",
            revisions: {
              remote: () => Effect.succeed(remoteRevision),
              local: () => Effect.succeed(localRevision),
            },
          },
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(watchStarted);
        yield* Effect.yieldNow;
        remoteRevision = "remote-2";
        yield* TestClock.adjust("1 second");
        yield* Queue.take(pullAttempted);
        assert.equal(attempts, 1);
        let failedStatus: VaultSyncStatus | null = null;
        while (failedStatus?.state !== "error") {
          yield* Effect.yieldNow;
          failedStatus = yield* readSyncStatus(root);
        }

        yield* Queue.offer(batches, ["note.md"]);
        yield* Queue.take(pullAttempted);
        yield* Deferred.await(pushed);
        assert.equal(attempts, 2);
        let recoveredStatus: VaultSyncStatus | null = null;
        while (recoveredStatus?.state !== "clean") {
          yield* Effect.yieldNow;
          recoveredStatus = yield* readSyncStatus(root);
        }
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("clears a poll error after a later unchanged revision check succeeds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-check-recover-" });
        const batches = yield* Queue.make<ReadonlyArray<string>>();
        const watchStarted = yield* Deferred.make<void>();
        const batchStream = Stream.fromEffect(Deferred.succeed(watchStarted, undefined)).pipe(
          Stream.drain,
          Stream.concat(Stream.fromQueue(batches)),
        );
        let checks = 0;

        const fiber = yield* runVaultWatchBatches(
          root,
          batchStream,
          {
            push: () => Effect.succeed({ revision: "local" }),
            pull: () => Effect.succeed({ revision: "remote-1" }),
          },
          {
            pollInterval: "1 second",
            revisions: {
              remote: () => {
                checks += 1;
                return checks === 2
                  ? Effect.fail(new VaultCloudRequestError({ operation: "get manifest" }))
                  : Effect.succeed("remote-1");
              },
              local: () => Effect.succeed("remote-1"),
            },
          },
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(watchStarted);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        let failedStatus: VaultSyncStatus | null = null;
        while (failedStatus?.state !== "error") {
          yield* Effect.yieldNow;
          failedStatus = yield* readSyncStatus(root);
        }

        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        assert.equal(checks, 3);
        let recoveredStatus: VaultSyncStatus | null = null;
        while (recoveredStatus?.state !== "clean") {
          yield* Effect.yieldNow;
          recoveredStatus = yield* readSyncStatus(root);
        }
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("does not clear an unrelated push error on an unchanged poll", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-push-error-" });
        const batches = yield* Queue.make<ReadonlyArray<string>>();
        const remoteChecked = yield* Queue.make<void>();
        let checks = 0;

        const fiber = yield* runVaultWatchBatches(
          root,
          Stream.fromQueue(batches),
          {
            push: () => Effect.fail(new VaultCloudRequestError({ operation: "upload object" })),
            pull: () => Effect.succeed({ revision: "remote-1" }),
          },
          {
            pollInterval: "1 second",
            revisions: {
              remote: () =>
                Effect.gen(function* () {
                  checks += 1;
                  yield* Queue.offer(remoteChecked, undefined);
                  return "remote-1";
                }),
              local: () => Effect.succeed("remote-1"),
            },
          },
        ).pipe(Effect.forkScoped);
        yield* Queue.take(remoteChecked);
        yield* Queue.offer(batches, ["note.md"]);

        let failedStatus: VaultSyncStatus | null = null;
        while (failedStatus?.state !== "error") {
          yield* Effect.yieldNow;
          failedStatus = yield* readSyncStatus(root);
        }
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Queue.take(remoteChecked);

        assert.equal(checks, 2);
        assert.equal((yield* readSyncStatus(root))?.state, "error");
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("disables interval checks when the poll interval is zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-watch-no-poll-" });
        const batches = yield* Queue.make<ReadonlyArray<string>>();
        let checks = 0;

        const fiber = yield* runVaultWatchBatches(
          root,
          Stream.fromQueue(batches),
          {
            push: () => Effect.succeed({ revision: "local" }),
            pull: () => Effect.succeed({ revision: "remote-1" }),
          },
          {
            pollInterval: 0,
            revisions: {
              remote: () =>
                Effect.sync(() => {
                  checks += 1;
                  return "remote-1";
                }),
              local: () => Effect.succeed("remote-1"),
            },
          },
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.equal(checks, 1);

        yield* TestClock.adjust("1 hour");
        assert.equal(checks, 1);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
});
