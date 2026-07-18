import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { defaultConfig } from "./Config.ts";
import { exportVault } from "./Export.ts";

const nodeServicesIt = it.layer(NodeServices.layer);

describe("Export.exportVault", () => {
  nodeServicesIt("node services", (it) => {
    it.effect("exports records with frontmatter, unknown fields, and bodies", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const vault = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-export-" });
          yield* fs.makeDirectory(path.join(vault, "tasks"), { recursive: true });
          yield* fs.writeFileString(
            path.join(vault, "tasks", "one.md"),
            "---\ntype: task\nid: task-one\ntitle: One\nstatus: todo\nx_custom: kept\n---\n\nBody. #tagged\n",
          );
          yield* fs.writeFileString(path.join(vault, "plain.md"), "# Plain\n");

          const result = yield* exportVault({ vaultRoot: vault, config: defaultConfig });
          assert.strictEqual(result.jbomExport, "1");
          assert.strictEqual(result.fileCount, 2);
          assert.deepStrictEqual(
            result.records.map((record) => record.path),
            ["plain.md", "tasks/one.md"],
          );

          const task = result.records[1];
          assert.strictEqual(task?.type, "task");
          assert.isTrue(task?.valid);
          assert.strictEqual(task?.frontmatter["x_custom"], "kept");
          assert.deepStrictEqual(task?.tags, ["tagged"]);
          assert.include(task?.body ?? "", "Body. #tagged");

          const plain = result.records[0];
          assert.isUndefined(plain?.type);
          assert.strictEqual(plain?.title, "Plain");

          const withoutBodies = yield* exportVault({
            vaultRoot: vault,
            config: defaultConfig,
            includeBody: false,
          });
          assert.isUndefined(withoutBodies.records[1]?.body);
        }),
      ),
    );
  });
});
