import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { defaultConfig, loadConfig, makeIgnoreMatcher, resolveConfig } from "./Config.ts";

const nodeServicesIt = it.layer(NodeServices.layer);

describe("Config.resolveConfig", () => {
  it("provides working defaults for an empty config", () => {
    assert.deepStrictEqual(defaultConfig.contentRoots, ["."]);
    assert.strictEqual(defaultConfig.runtimeDir, ".jbom");
    assert.isTrue(defaultConfig.types.has("task"));
    assert.isTrue(defaultConfig.types.has("note"));
    assert.isTrue(defaultConfig.types.has("project"));
    assert.isTrue(defaultConfig.types.has("journal"));
    assert.isTrue(defaultConfig.types.has("collection"));
  });

  it("registers custom types with required fields and kinds", () => {
    const resolved = resolveConfig({
      types: {
        meeting: { required: ["date"], optional: ["attendees"], fields: { date: "date" } },
      },
    });
    const meeting = resolved.types.get("meeting");
    assert.deepStrictEqual(meeting?.required, ["date"]);
    assert.strictEqual(meeting?.fields["date"], "date");
    assert.strictEqual(meeting?.fields["attendees"], "unknown");
  });

  it("lets custom config extend a built-in type", () => {
    const resolved = resolveConfig({
      types: { task: { required: ["status", "project"] } },
    });
    assert.deepStrictEqual(resolved.types.get("task")?.required, ["status", "project"]);
    assert.strictEqual(resolved.types.get("task")?.fields["due"], "date");
  });
});

describe("Config.makeIgnoreMatcher", () => {
  it("ignores default directories and dot-directories anywhere", () => {
    const isIgnored = makeIgnoreMatcher([]);
    assert.isTrue(isIgnored("node_modules/pkg/readme.md"));
    assert.isTrue(isIgnored("project/node_modules/x.md"));
    assert.isTrue(isIgnored(".git/config"));
    assert.isTrue(isIgnored(".obsidian/workspace.json"));
    assert.isTrue(isIgnored(".jbom/index.sqlite"));
    assert.isTrue(isIgnored("some/.trash/old.md"));
    assert.isFalse(isIgnored("projects/jbom/tasks/I-01-00-x.md"));
    assert.isFalse(isIgnored("notes.md"));
  });

  it("applies config globs", () => {
    const isIgnored = makeIgnoreMatcher(["archive/**", "**/*.tmp.md", "Airbnb old/**"]);
    assert.isTrue(isIgnored("archive/2020/old.md"));
    assert.isTrue(isIgnored("deep/nested/file.tmp.md"));
    assert.isTrue(isIgnored("Airbnb old/README.md"));
    assert.isFalse(isIgnored("archives/current.md"));
  });
});

nodeServicesIt("Config.loadConfig", (it) => {
  it.effect("falls back to defaults when jbom.json is absent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-config-" });
        const config = yield* loadConfig(tempDir);
        assert.deepStrictEqual(config.contentRoots, ["."]);
      }),
    ),
  );

  it.effect("loads and validates jbom.json", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-config-" });
        yield* fs.writeFileString(
          path.join(tempDir, "jbom.json"),
          '{ "name": "Test Vault", "ignore": ["archive/**"] }',
        );
        const config = yield* loadConfig(tempDir);
        assert.strictEqual(config.name, "Test Vault");
        assert.deepStrictEqual(config.ignore, ["archive/**"]);
      }),
    ),
  );

  it.effect("fails with a readable error on malformed jbom.json", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-config-" });
        yield* fs.writeFileString(path.join(tempDir, "jbom.json"), "{ not json");
        const result = yield* loadConfig(tempDir).pipe(Effect.flip);
        assert.strictEqual(result._tag, "JbomConfigError");
        assert.include(result.message, "Invalid jbom.json");
      }),
    ),
  );
});
