import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  isSyncStatusStale,
  readSyncStatus,
  SYNC_STATUS_SCHEMA,
  updateSyncStatus,
  writeSyncStatus,
} from "./syncStatus.ts";

it.layer(NodeServices.layer)("vault sync status", (it) => {
  const makeRoot = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "vault-sync-status-" });
  });

  it.effect("moves from pending through pushing to clean while retaining revisions", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const pending = yield* updateSyncStatus(root, {
        state: "pending",
        pendingPaths: ["b.md", "a.md", "b.md"],
      });
      assert.equal(pending.state, "pending");
      assert.deepEqual(pending.pendingPaths, ["a.md", "b.md"]);
      assert.isNull(pending.lastSuccessfulSyncAt);

      const pushing = yield* updateSyncStatus(root, { state: "pushing" });
      assert.equal(pushing.state, "pushing");
      assert.deepEqual(pushing.pendingPaths, ["a.md", "b.md"]);

      const clean = yield* updateSyncStatus(root, {
        state: "clean",
        lastPushedRevision: "revision-2",
        lastPulledRevision: "revision-1",
        successful: true,
      });
      assert.equal(clean.state, "clean");
      assert.deepEqual(clean.pendingPaths, []);
      assert.equal(clean.lastPushedRevision, "revision-2");
      assert.equal(clean.lastPulledRevision, "revision-1");
      assert.equal(clean.lastSuccessfulSyncAt, clean.updatedAt);
    }),
  );

  it.effect("atomically replaces status.json without leaving temporary files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      const first = {
        schema: SYNC_STATUS_SCHEMA,
        state: "pending" as const,
        updatedAt: "2026-07-19T01:00:00.000Z",
        lastSuccessfulSyncAt: null,
        lastPushedRevision: null,
        lastPulledRevision: null,
        pendingPaths: ["first.md"],
        lastError: null,
      };
      yield* writeSyncStatus(root, first);
      yield* writeSyncStatus(root, {
        ...first,
        state: "error",
        updatedAt: "2026-07-19T01:01:00.000Z",
        lastError: "network unavailable",
      });

      const status = yield* readSyncStatus(root);
      assert.equal(status?.state, "error");
      assert.equal(status?.lastError, "network unavailable");
      const names = yield* fs.readDirectory(path.join(root, ".apnatasks", "sync"));
      assert.deepEqual(names, ["status.json"]);
    }),
  );

  it("only treats old in-progress states as stale", () => {
    const status = {
      schema: SYNC_STATUS_SCHEMA,
      state: "pushing" as const,
      updatedAt: "2026-07-19T01:00:00.000Z",
      lastSuccessfulSyncAt: null,
      lastPushedRevision: null,
      lastPulledRevision: null,
      pendingPaths: [],
      lastError: null,
    };
    assert.isFalse(isSyncStatusStale(status, Date.parse("2026-07-19T01:04:59.999Z")));
    assert.isTrue(isSyncStatusStale(status, Date.parse("2026-07-19T01:05:00.000Z")));
    assert.isFalse(isSyncStatusStale({ ...status, state: "error" }, Number.POSITIVE_INFINITY));
  });
});
