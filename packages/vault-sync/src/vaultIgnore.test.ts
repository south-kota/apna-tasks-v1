import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  loadVaultIgnore,
  matchesVaultIgnore,
  parseVaultIgnore,
  VAULT_IGNORE_FILE,
} from "./vaultIgnore.ts";

describe("vault ignore", () => {
  it("parses names and root-relative prefixes while skipping comments and blanks", () => {
    const rules = parseVaultIgnore(`
# repositories
chattu

Airbnb old/drafts
private.md
`);

    assert.deepEqual([...rules.names], ["chattu", "private.md"]);
    assert.deepEqual([...rules.prefixes], ["Airbnb old/drafts"]);
    assert.isTrue(matchesVaultIgnore("projects/chattu/README.md", rules));
    assert.isTrue(matchesVaultIgnore("Airbnb old/drafts/idea.md", rules));
    assert.isFalse(matchesVaultIgnore("Airbnb old/drafts-old/idea.md", rules));
    assert.isFalse(matchesVaultIgnore("projects/chattu-notes/README.md", rules));
    assert.isFalse(matchesVaultIgnore("projects/Chattu/README.md", rules));
  });
});

it.layer(NodeServices.layer)("vault ignore loader", (it) => {
  it.effect("returns empty rules when the root ignore file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-ignore-" });
      const rules = yield* loadVaultIgnore(root);
      assert.deepEqual([...rules.names], []);
      assert.deepEqual([...rules.prefixes], []);
    }),
  );

  it.effect("loads rules from the vault root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "vault-ignore-" });
      yield* fs.writeFileString(path.join(root, VAULT_IGNORE_FILE), "repo\nnotes/private\n");
      const rules = yield* loadVaultIgnore(root);
      assert.isTrue(matchesVaultIgnore("deep/repo/file.md", rules));
      assert.isTrue(matchesVaultIgnore("notes/private/file.md", rules));
    }),
  );
});
