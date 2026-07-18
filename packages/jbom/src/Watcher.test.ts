import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { VaultFileEvent } from "./Model.ts";
import { watchVault } from "./Watcher.ts";

// Real clock + real filesystem: watcher debouncing cannot run under the
// TestClock that `it.effect` installs, so these use `it.live`.
describe("Watcher.watchVault", () => {
  it.live(
    "batches rapid changes and applies ignore rules",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const vault = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-watch-" });
          yield* fs.makeDirectory(path.join(vault, "tasks"), { recursive: true });
          yield* fs.makeDirectory(path.join(vault, "node_modules", "pkg"), { recursive: true });

          const batches = yield* Queue.make<ReadonlyArray<VaultFileEvent>>();
          const fiber = yield* watchVault(vault, { debounce: "150 millis" }).pipe(
            Stream.runForEach((batch) => Queue.offer(batches, batch)),
            Effect.forkScoped,
          );

          // Let the watcher attach before writing.
          yield* Effect.sleep("200 millis");

          yield* fs.writeFileString(
            path.join(vault, "tasks", "a.md"),
            "---\ntype: task\nid: t-a\ntitle: A\nstatus: todo\n---\n",
          );
          yield* fs.writeFileString(path.join(vault, "tasks", "b.md"), "# b\n");
          yield* fs.writeFileString(path.join(vault, "ignored.txt"), "not markdown");
          yield* fs.writeFileString(path.join(vault, "node_modules", "pkg", "x.md"), "# ignored\n");

          const batch = yield* Queue.take(batches).pipe(Effect.timeout("10 seconds"));
          const paths = batch.map((event) => event.path).sort();
          assert.deepStrictEqual(paths, ["tasks/a.md", "tasks/b.md"]);
          assert.isTrue(batch.every((event) => event.kind === "updated"));

          // A later edit arrives as a separate debounced batch.
          yield* fs.writeFileString(path.join(vault, "tasks", "b.md"), "# b changed\n");
          const second = yield* Queue.take(batches).pipe(Effect.timeout("10 seconds"));
          assert.deepStrictEqual(
            second.map((event) => event.path),
            ["tasks/b.md"],
          );

          yield* Fiber.interrupt(fiber);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    20_000,
  );

  it.live(
    "reports removals",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const vault = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-watch-rm-" });
          yield* fs.writeFileString(path.join(vault, "doomed.md"), "# doomed\n");

          const batches = yield* Queue.make<ReadonlyArray<VaultFileEvent>>();
          yield* watchVault(vault, { debounce: "150 millis" }).pipe(
            Stream.runForEach((batch) => Queue.offer(batches, batch)),
            Effect.forkScoped,
          );
          yield* Effect.sleep("200 millis");

          yield* fs.remove(path.join(vault, "doomed.md"));
          // macOS FSEvents may replay the pre-attach creation first; drain
          // batches until the removal shows up.
          const seen: Array<VaultFileEvent> = [];
          while (!seen.some((event) => event.kind === "removed" && event.path === "doomed.md")) {
            const batch = yield* Queue.take(batches).pipe(Effect.timeout("10 seconds"));
            seen.push(...batch);
          }
          assert.isTrue(seen.every((event) => event.path === "doomed.md"));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    20_000,
  );
});
