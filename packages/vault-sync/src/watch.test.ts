import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
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
import { readSyncStatus, type VaultSyncStatus } from "./syncStatus.ts";
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
});
