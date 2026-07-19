import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { sha256Hex, VAULT_MANIFEST_SCHEMA, type VaultManifest } from "./manifest.ts";
import { updateSyncStatus } from "./syncStatus.ts";
import { applyVaultManifest, scanVault, VaultObjectIntegrityError } from "./vault.ts";

const encoder = new TextEncoder();

const manifestFor = (
  files: ReadonlyArray<{ path: string; bytes: Uint8Array; mediaType: string }>,
  revision = "revision-2",
): { manifest: VaultManifest; objects: Map<string, Uint8Array> } => {
  const objects = new Map<string, Uint8Array>();
  const manifest: VaultManifest = {
    schema: VAULT_MANIFEST_SCHEMA,
    vaultId: "test-vault",
    revision,
    generatedAt: "2026-07-18T01:00:00.000Z",
    files: files
      .map(({ path, bytes, mediaType }) => {
        const digest = sha256Hex(bytes);
        objects.set(digest, bytes);
        return { path, sha256: digest, size: bytes.byteLength, mediaType };
      })
      .toSorted((left, right) => left.path.localeCompare(right.path)),
  };
  return { manifest, objects };
};

it.layer(NodeServices.layer)("vault filesystem sync", (it) => {
  const makeRoot = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "vault-sync-" });
  });

  it.effect("scans supported files and skips ignored directories and symlinks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      yield* fs.makeDirectory(path.join(root, "nested"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "note.md"), "# hello\n");
      yield* fs.writeFileString(path.join(root, "private.md"), "ignored file\n");
      yield* fs.writeFileString(path.join(root, "nested", "record.json"), "{}\n");
      yield* fs.writeFile(path.join(root, "pixel.png"), Uint8Array.from([137, 80, 78, 71]));
      yield* fs.writeFileString(path.join(root, "binary.exe"), "skipped");
      yield* fs.symlink(path.join(root, "note.md"), path.join(root, "linked.md"));
      yield* fs.makeDirectory(path.join(root, "projects", "chattu"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "projects", "chattu", "README.md"), "ignored");
      yield* fs.makeDirectory(path.join(root, "Airbnb old", "drafts"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "Airbnb old", "published"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "Airbnb old", "drafts", "idea.md"), "ignored");
      yield* fs.writeFileString(path.join(root, "Airbnb old", "published", "note.md"), "kept");
      yield* fs.writeFileString(
        path.join(root, ".vaultignore"),
        "# local repositories\nchattu\nAirbnb old/drafts\nprivate.md\n",
      );
      for (const ignored of [".git", ".obsidian", "node_modules", ".apnatasks", ".cache"]) {
        yield* fs.makeDirectory(path.join(root, ignored), { recursive: true });
        yield* fs.writeFileString(path.join(root, ignored, "hidden.md"), "ignored");
      }
      yield* updateSyncStatus(root, { state: "pending", pendingPaths: ["note.md"] });

      const manifest = yield* scanVault(root, {
        vaultId: "test-vault",
        revision: "revision-1",
        generatedAt: "2026-07-18T00:00:00.000Z",
      });

      assert.deepEqual(
        manifest.files.map((entry) => entry.path),
        ["Airbnb old/published/note.md", "nested/record.json", "note.md", "pixel.png"],
      );
    }),
  );

  it.effect("restores files byte-identically and atomically", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      const note = encoder.encode("# exact\r\n\r\nspacing\r\n");
      const image = Uint8Array.from([0, 1, 2, 3, 254, 255]);
      const { manifest, objects } = manifestFor([
        { path: "a.md", bytes: note, mediaType: "text/markdown" },
        { path: "images/raw.webp", bytes: image, mediaType: "image/webp" },
      ]);

      const result = yield* applyVaultManifest(root, manifest, (digest) =>
        Effect.succeed(objects.get(digest) ?? new Uint8Array()),
      );

      assert.deepEqual(result.created, ["a.md", "images/raw.webp"]);
      assert.deepEqual(yield* fs.readFile(path.join(root, "a.md")), note);
      assert.deepEqual(yield* fs.readFile(path.join(root, "images", "raw.webp")), image);
      for (const directory of [root, path.join(root, "images")]) {
        assert.isFalse(
          (yield* fs.readDirectory(directory)).some((name) => name.includes(".apnatasks-")),
        );
      }
    }),
  );

  it.effect("fast-forwards unmodified local files without conflict copies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      const oldBytes = encoder.encode("old\n");
      yield* fs.writeFile(path.join(root, "note.md"), oldBytes);
      const { manifest, objects } = manifestFor([
        { path: "note.md", bytes: encoder.encode("new\n"), mediaType: "text/markdown" },
      ]);

      const result = yield* applyVaultManifest(
        root,
        manifest,
        (digest) => Effect.succeed(objects.get(digest) ?? new Uint8Array()),
        { baseFiles: new Map([["note.md", sha256Hex(oldBytes)]]) },
      );

      assert.deepEqual(result.updated, ["note.md"]);
      assert.deepEqual(result.conflicts, []);
      assert.equal(yield* fs.readFileString(path.join(root, "note.md")), "new\n");
    }),
  );

  it.effect("keeps the losing local edit as a conflict copy when both sides changed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      yield* fs.writeFileString(path.join(root, "note.md"), "local edit\n");
      const { manifest, objects } = manifestFor([
        { path: "note.md", bytes: encoder.encode("remote edit\n"), mediaType: "text/markdown" },
      ]);

      const result = yield* applyVaultManifest(
        root,
        manifest,
        (digest) => Effect.succeed(objects.get(digest) ?? new Uint8Array()),
        { baseFiles: new Map([["note.md", sha256Hex(encoder.encode("base\n"))]]) },
      );

      assert.equal(yield* fs.readFileString(path.join(root, "note.md")), "remote edit\n");
      assert.deepEqual(result.conflicts, [
        { path: "note.md", localCopyPath: ".apnatasks/conflicts/revision-2/note.md" },
      ]);
      assert.equal(
        yield* fs.readFileString(
          path.join(root, ".apnatasks", "conflicts", "revision-2", "note.md"),
        ),
        "local edit\n",
      );
    }),
  );

  it.effect("prunes remote deletions only when the local file is unmodified", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      const keptBytes = encoder.encode("locally modified\n");
      const removedBytes = encoder.encode("unchanged\n");
      yield* fs.writeFile(path.join(root, "kept.md"), keptBytes);
      yield* fs.writeFile(path.join(root, "removed.md"), removedBytes);
      const { manifest, objects } = manifestFor([]);

      const result = yield* applyVaultManifest(
        root,
        manifest,
        (digest) => Effect.succeed(objects.get(digest) ?? new Uint8Array()),
        {
          baseFiles: new Map([
            ["kept.md", sha256Hex(encoder.encode("base version\n"))],
            ["removed.md", sha256Hex(removedBytes)],
          ]),
          prune: true,
        },
      );

      assert.deepEqual(result.deleted, ["removed.md"]);
      assert.deepEqual(result.keptModified, ["kept.md"]);
      assert.isFalse(yield* fs.exists(path.join(root, "removed.md")));
      assert.deepEqual(yield* fs.readFile(path.join(root, "kept.md")), keptBytes);
    }),
  );

  it.effect("fails without writing when object bytes do not match the manifest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      const { manifest } = manifestFor([
        { path: "note.md", bytes: encoder.encode("expected"), mediaType: "text/markdown" },
      ]);

      const error = yield* applyVaultManifest(root, manifest, () =>
        Effect.succeed(encoder.encode("corrupt")),
      ).pipe(Effect.flip);
      assert.instanceOf(error, VaultObjectIntegrityError);
      assert.isFalse(yield* fs.exists(path.join(root, "note.md")));
    }),
  );
});
