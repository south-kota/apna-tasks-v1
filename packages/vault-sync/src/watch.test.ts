import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ManifestPreconditionError, VaultCloudRequestError } from "./client.ts";
import { RemoteManifestChangedError } from "./sync.ts";
import { debounceWatchEvents, runWatchCycle } from "./watch.ts";

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
        pull: () => Effect.sync(() => calls.push("pull")),
      });

      assert.deepEqual(calls, ["push"]);
      assert.deepEqual(result, { revision: "rev-1", retried: false });
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
        pull: () => Effect.sync(() => calls.push("pull")),
      });

      assert.deepEqual(calls, ["push", "pull", "push"]);
      assert.deepEqual(result, { revision: "rev-2", retried: true });
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
        pull: () => Effect.sync(() => calls.push("pull")),
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
        pull: () => Effect.sync(() => calls.push("pull")),
      }).pipe(Effect.flip);

      assert.deepEqual(calls, ["push"]);
      assert.instanceOf(failure, VaultCloudRequestError);
    }),
  );
});
