import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { renameFile, trashFile, writeFileAtomic } from "./FileOps.ts";

const nodeServicesIt = it.layer(NodeServices.layer);

describe("FileOps", () => {
  nodeServicesIt("node services", (it) => {
    it.effect("writeFileAtomic writes contents and leaves no temp files", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-fileops-" });
          const target = path.join(tempDir, "nested", "record.md");

          yield* writeFileAtomic(target, "---\ntype: note\n---\nhello\n");
          assert.strictEqual(yield* fs.readFileString(target), "---\ntype: note\n---\nhello\n");

          yield* writeFileAtomic(target, "replaced\n");
          assert.strictEqual(yield* fs.readFileString(target), "replaced\n");

          const entries = yield* fs.readDirectory(path.join(tempDir, "nested"));
          assert.deepStrictEqual(entries, ["record.md"]);
        }),
      ),
    );

    it.effect("renameFile refuses to overwrite unless asked", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-fileops-" });
          const source = path.join(tempDir, "I-01-00-task.md");
          const target = path.join(tempDir, "O-01-00-task.md");
          yield* fs.writeFileString(source, "a");
          yield* fs.writeFileString(target, "b");

          const error = yield* renameFile(source, target).pipe(Effect.flip);
          assert.strictEqual(error._tag, "JbomFileError");
          assert.include(error.message, "already exists");

          yield* renameFile(source, target, { overwrite: true });
          assert.strictEqual(yield* fs.readFileString(target), "a");
        }),
      ),
    );

    it.effect("renameFile creates target directories", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-fileops-" });
          const source = path.join(tempDir, "loose.md");
          yield* fs.writeFileString(source, "x");
          yield* renameFile(source, path.join(tempDir, "archive", "2026", "loose.md"));
          assert.strictEqual(
            yield* fs.readFileString(path.join(tempDir, "archive", "2026", "loose.md")),
            "x",
          );
        }),
      ),
    );

    it.effect("trashFile soft-deletes preserving the relative path", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const vault = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-vault-" });
          yield* fs.makeDirectory(path.join(vault, "projects", "demo"), { recursive: true });
          const original = path.join(vault, "projects", "demo", "note.md");
          yield* fs.writeFileString(original, "precious content\n");

          const trashPath = yield* trashFile({
            vaultRoot: vault,
            relativePath: "projects/demo/note.md",
          });

          assert.isFalse(yield* fs.exists(original));
          assert.include(trashPath, `${path.sep}.jbom${path.sep}trash${path.sep}`);
          assert.isTrue(trashPath.endsWith(path.join("projects", "demo", "note.md")));
          assert.strictEqual(yield* fs.readFileString(trashPath), "precious content\n");
        }),
      ),
    );
  });
});
