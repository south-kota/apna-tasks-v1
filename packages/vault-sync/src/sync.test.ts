import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { VaultCloudClient, RemoteManifest } from "./client.ts";
import { ManifestPreconditionError, VaultCloudRequestError } from "./client.ts";
import { sha256Hex, type VaultManifest } from "./manifest.ts";
import { pullVault, pushVault, RemoteManifestChangedError, statusVault } from "./sync.ts";

const encoder = new TextEncoder();

/** In-memory cloud with the same compare-and-set manifest semantics as the API. */
function makeFakeCloud(): { client: VaultCloudClient; objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  let current: RemoteManifest | null = null;
  let counter = 0;
  const client: VaultCloudClient = {
    getManifest: () => Effect.sync(() => current),
    putManifest: (manifest: VaultManifest, expectedEtag: string | null) =>
      Effect.suspend(() => {
        const actual = current?.etag ?? null;
        if (actual !== expectedEtag) {
          return Effect.fail(new ManifestPreconditionError({ vaultId: manifest.vaultId }));
        }
        counter += 1;
        const etag = `etag-${counter}`;
        current = { manifest, etag };
        return Effect.succeed(etag);
      }),
    objectExists: (_vaultId, digest) => Effect.sync(() => objects.has(digest)),
    uploadObject: (_vaultId, digest, bytes) =>
      Effect.sync(() => {
        objects.set(digest, bytes);
      }),
    downloadObject: (_vaultId, digest) =>
      Effect.suspend(() => {
        const bytes = objects.get(digest);
        return bytes === undefined
          ? Effect.fail(new VaultCloudRequestError({ operation: "download object", status: 404 }))
          : Effect.succeed(bytes);
      }),
  };
  return { client, objects };
}

it.layer(NodeServices.layer)("push/pull sync", (it) => {
  const makeRoot = (prefix: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectoryScoped({ prefix });
    });

  const syncOptions = (root: string, client: VaultCloudClient, revision: string) => ({
    root,
    vaultId: "test-vault",
    revision,
    generatedAt: "2026-07-18T02:00:00.000Z",
    client,
  });

  it.effect("pushes, wipes, and pulls a byte-identical vault", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { client } = makeFakeCloud();
      const source = yield* makeRoot("vault-sync-src-");
      const restore = yield* makeRoot("vault-sync-restore-");
      const image = Uint8Array.from([1, 2, 3, 250, 251]);
      yield* fs.makeDirectory(path.join(source, "notes"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "notes", "a.md"), "# A\r\nwindows line\r\n");
      yield* fs.writeFileString(path.join(source, "data.json"), '{"x":1}\n');
      yield* fs.writeFile(path.join(source, "img.png"), image);

      const pushed = yield* pushVault(syncOptions(source, client, "rev-1"));
      assert.equal(pushed.uploaded, 3);

      const pulled = yield* pullVault({ root: restore, vaultId: "test-vault", client });
      assert.equal(pulled.result.created.length, 3);
      assert.equal(
        yield* fs.readFileString(path.join(restore, "notes", "a.md")),
        "# A\r\nwindows line\r\n",
      );
      assert.equal(yield* fs.readFileString(path.join(restore, "data.json")), '{"x":1}\n');
      assert.deepEqual(yield* fs.readFile(path.join(restore, "img.png")), image);

      const status = yield* statusVault(syncOptions(restore, client, "rev-status"));
      assert.isTrue(status.inSync);
    }),
  );

  it.effect("re-pushing identical content uploads nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { client } = makeFakeCloud();
      const source = yield* makeRoot("vault-sync-idem-");
      yield* fs.writeFileString(path.join(source, "a.md"), "same\n");
      const first = yield* pushVault(syncOptions(source, client, "rev-1"));
      const second = yield* pushVault(syncOptions(source, client, "rev-2"));
      assert.equal(first.uploaded, 1);
      assert.equal(second.uploaded, 0);
      assert.equal(second.etag, first.etag);
    }),
  );

  it.effect("concurrent edits: stale push is rejected, pull keeps the losing edit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { client } = makeFakeCloud();
      const macA = yield* makeRoot("vault-sync-a-");
      const macB = yield* makeRoot("vault-sync-b-");
      yield* fs.writeFileString(path.join(macA, "note.md"), "base\n");
      yield* pushVault(syncOptions(macA, client, "rev-1"));
      yield* pullVault({ root: macB, vaultId: "test-vault", client });

      // Both machines edit the same file; A pushes first and wins.
      yield* fs.writeFileString(path.join(macA, "note.md"), "A wins\n");
      yield* fs.writeFileString(path.join(macB, "note.md"), "B loses\n");
      yield* pushVault(syncOptions(macA, client, "rev-2"));

      const rejected = yield* pushVault(syncOptions(macB, client, "rev-3")).pipe(Effect.flip);
      assert.instanceOf(rejected, RemoteManifestChangedError);

      const pulled = yield* pullVault({ root: macB, vaultId: "test-vault", client });
      assert.equal(pulled.result.conflicts.length, 1);
      assert.equal(yield* fs.readFileString(path.join(macB, "note.md")), "A wins\n");
      const copyPath = pulled.result.conflicts[0]!.localCopyPath;
      assert.equal(yield* fs.readFileString(path.join(macB, ...copyPath.split("/"))), "B loses\n");

      // After reconciling, B can push again.
      const repushed = yield* pushVault(syncOptions(macB, client, "rev-4"));
      // The conflict copy itself is excluded from the manifest (.apnatasks is ignored).
      assert.deepEqual(
        repushed.manifest.files.map((entry) => entry.path),
        ["note.md"],
      );
    }),
  );

  it.effect("pull prunes remote deletions but keeps locally modified files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { client } = makeFakeCloud();
      const macA = yield* makeRoot("vault-sync-a-");
      const macB = yield* makeRoot("vault-sync-b-");
      yield* fs.writeFileString(path.join(macA, "stays.md"), "stays\n");
      yield* fs.writeFileString(path.join(macA, "removed.md"), "old\n");
      yield* fs.writeFileString(path.join(macA, "edited.md"), "old edit target\n");
      yield* pushVault(syncOptions(macA, client, "rev-1"));
      yield* pullVault({ root: macB, vaultId: "test-vault", client });

      // A deletes two files; B edits one of them before pulling.
      yield* fs.remove(path.join(macA, "removed.md"));
      yield* fs.remove(path.join(macA, "edited.md"));
      yield* pushVault(syncOptions(macA, client, "rev-2"));
      yield* fs.writeFileString(path.join(macB, "edited.md"), "B local edit\n");

      const pulled = yield* pullVault({ root: macB, vaultId: "test-vault", client });
      assert.deepEqual(pulled.result.deleted, ["removed.md"]);
      assert.deepEqual(pulled.result.keptModified, ["edited.md"]);
      assert.isFalse(yield* fs.exists(path.join(macB, "removed.md")));
      assert.equal(yield* fs.readFileString(path.join(macB, "edited.md")), "B local edit\n");
    }),
  );

  it.effect("force push overwrites a changed remote", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { client } = makeFakeCloud();
      const macA = yield* makeRoot("vault-sync-a-");
      const macB = yield* makeRoot("vault-sync-b-");
      yield* fs.writeFileString(path.join(macA, "note.md"), "from A\n");
      yield* pushVault(syncOptions(macA, client, "rev-1"));
      yield* fs.writeFileString(path.join(macB, "note.md"), "from B\n");

      const rejected = yield* pushVault(syncOptions(macB, client, "rev-2")).pipe(Effect.flip);
      assert.instanceOf(rejected, RemoteManifestChangedError);

      const forced = yield* pushVault({ ...syncOptions(macB, client, "rev-3"), force: true });
      const remote = yield* client.getManifest("test-vault");
      assert.equal(remote?.etag, forced.etag);
      assert.equal(remote?.manifest.files[0]?.sha256, sha256Hex(encoder.encode("from B\n")));
    }),
  );
});
