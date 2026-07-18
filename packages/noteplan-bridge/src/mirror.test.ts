import { assert, describe, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { syncPass, type MirrorConfig, type SyncPassResult } from "./mirror.ts";

const TestLayer = Layer.mergeAll(NodeFileSystem.layer, Path.layer);

interface Fixture {
  readonly config: MirrorConfig;
  readonly vaultDir: string;
  readonly notePlanDir: string;
}

const makeFixture = Effect.fnUntraced(function* (options?: { mirrorFolders?: Array<string> }) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "noteplan-bridge-test-" });
  const vaultDir = `${root}/vault`;
  const notePlanDir = `${root}/noteplan`;
  yield* fs.makeDirectory(`${vaultDir}/Daily`, { recursive: true });
  yield* fs.makeDirectory(`${notePlanDir}/Calendar`, { recursive: true });
  yield* fs.makeDirectory(`${notePlanDir}/Notes`, { recursive: true });
  const config: MirrorConfig = {
    vaultDir,
    notePlanDir,
    dailyFolder: "Daily",
    notesFolder: "Apna",
    mirrorFolders: options?.mirrorFolders ?? [],
    ledgerPath: `${root}/ledger.json`,
  };
  return { config, vaultDir, notePlanDir } satisfies Fixture;
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestLayer));

const write = Effect.fnUntraced(function* (
  filePath: string,
  content: string,
  mtimeSeconds?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, content);
  if (mtimeSeconds !== undefined) {
    yield* fs.utimes(filePath, mtimeSeconds * 1000, mtimeSeconds * 1000);
  }
});

const read = Effect.fnUntraced(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(filePath);
});

const exists = Effect.fnUntraced(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(filePath);
});

const assertNoWrites = (result: SyncPassResult) => {
  assert.strictEqual(result.writes, 0);
  assert.deepStrictEqual(result.results, []);
};

describe("mirror engine", () => {
  it.effect("mirrors a dated vault daily into NotePlan's Calendar and completion flows back", () =>
    run(
      Effect.gen(function* () {
        const { config, notePlanDir, vaultDir } = yield* makeFixture();
        const vaultPath = `${vaultDir}/Daily/2026-07-18.md`;
        const notePlanPath = `${notePlanDir}/Calendar/20260718.md`;
        yield* write(
          vaultPath,
          "---\ntype: daily\ndate: 2026-07-18\n---\n- [ ] water the plants\n- [ ] book flights 📅 2026-08-02\n",
        );

        const first = yield* syncPass(config);
        assert.strictEqual(first.writes, 1);
        const notePlanContent = yield* read(notePlanPath);
        assert.strictEqual(
          notePlanContent,
          "- [ ] water the plants\n- [ ] book flights >2026-08-02\n",
        );

        // Complete a task in NotePlan; it flows back to the vault.
        yield* write(notePlanPath, "- [x] water the plants\n- [ ] book flights >2026-08-02\n");
        const second = yield* syncPass(config);
        assert.strictEqual(second.writes, 1);
        const vaultContent = yield* read(vaultPath);
        assert.isTrue(vaultContent.startsWith("---\ntype: daily\ndate: 2026-07-18\n---\n"));
        assert.include(vaultContent, "- [x] water the plants");
        assert.include(vaultContent, "- [ ] book flights 📅 2026-08-02");
      }),
    ),
  );

  it.effect("imports a NotePlan-only daily into the vault with frontmatter", () =>
    run(
      Effect.gen(function* () {
        const { config, notePlanDir, vaultDir } = yield* makeFixture();
        yield* write(`${notePlanDir}/Calendar/20260801.md`, "- [ ] from noteplan\n");
        yield* syncPass(config);
        const vaultContent = yield* read(`${vaultDir}/Daily/2026-08-01.md`);
        assert.isTrue(vaultContent.startsWith("---\n"));
        assert.include(vaultContent, "date: 2026-08-01");
        assert.include(vaultContent, "- [ ] from noteplan");
      }),
    ),
  );

  it.effect("dual edit: newer side wins, loser is preserved as a vault conflict copy", () =>
    run(
      Effect.gen(function* () {
        const { config, notePlanDir, vaultDir } = yield* makeFixture();
        const vaultPath = `${vaultDir}/Daily/2026-07-18.md`;
        const notePlanPath = `${notePlanDir}/Calendar/20260718.md`;
        yield* write(vaultPath, "- [ ] original\n");
        yield* syncPass(config);

        // Edit both sides; NotePlan is newer.
        yield* write(vaultPath, "- [ ] vault edit\n", 1_000);
        yield* write(notePlanPath, "- [ ] noteplan edit\n", 2_000);
        const result = yield* syncPass(config);
        assert.strictEqual(result.results[0]?.action, "Conflict");
        assert.strictEqual(result.results[0]?.detail, "winner=notePlan");

        assert.include(yield* read(vaultPath), "- [ ] noteplan edit");
        assert.include(yield* read(notePlanPath), "- [ ] noteplan edit");

        const fs = yield* FileSystem.FileSystem;
        const dailyFiles = yield* fs.readDirectory(`${vaultDir}/Daily`);
        const conflictFile = dailyFiles.find((name) => name.includes(".conflict-"));
        assert.isDefined(conflictFile);
        assert.include(yield* read(`${vaultDir}/Daily/${conflictFile}`), "- [ ] vault edit");

        // Conflict copies never land inside NotePlan.
        const calendarFiles = yield* fs.readDirectory(`${notePlanDir}/Calendar`);
        assert.isFalse(calendarFiles.some((name) => name.includes(".conflict-")));
      }),
    ),
  );

  it.effect("dual edit: vault wins when it is newer", () =>
    run(
      Effect.gen(function* () {
        const { config, notePlanDir, vaultDir } = yield* makeFixture();
        const vaultPath = `${vaultDir}/Daily/2026-07-18.md`;
        const notePlanPath = `${notePlanDir}/Calendar/20260718.md`;
        yield* write(vaultPath, "- [ ] original\n");
        yield* syncPass(config);

        yield* write(notePlanPath, "- [ ] noteplan edit\n", 1_000);
        yield* write(vaultPath, "- [ ] vault edit\n", 2_000);
        const result = yield* syncPass(config);
        assert.strictEqual(result.results[0]?.detail, "winner=vault");
        assert.include(yield* read(notePlanPath), "- [ ] vault edit");
      }),
    ),
  );

  it.effect("loop protection: repeated passes after convergence perform zero writes", () =>
    run(
      Effect.gen(function* () {
        const { config, notePlanDir, vaultDir } = yield* makeFixture();
        yield* write(`${vaultDir}/Daily/2026-07-18.md`, "- [ ] task a 📅 2026-07-19\n");
        yield* write(`${notePlanDir}/Calendar/20260720.md`, "- [ ] task b\n");
        yield* syncPass(config);
        assertNoWrites(yield* syncPass(config));
        assertNoWrites(yield* syncPass(config));
        assertNoWrites(yield* syncPass(config));
      }),
    ),
  );

  it.effect("unmapped NotePlan files are never touched, imported, or deleted", () =>
    run(
      Effect.gen(function* () {
        const { config, notePlanDir, vaultDir } = yield* makeFixture();
        const untouched: Record<string, string> = {
          [`${notePlanDir}/Calendar/2026-W30.md`]: "* weekly note\n",
          [`${notePlanDir}/Calendar/2026-07.md`]: "* monthly note\n",
          [`${notePlanDir}/Calendar/_Archived Items/20250101.md`]: "archived\n",
          [`${notePlanDir}/Notes/Personal/secret.md`]: "- [ ] private noteplan task\n",
          [`${notePlanDir}/Notes/@Trash/gone.md`]: "trashed\n",
        };
        for (const [filePath, content] of Object.entries(untouched)) {
          yield* write(filePath, content);
        }
        yield* write(`${vaultDir}/Daily/2026-07-18.md`, "- [ ] mapped task\n");

        yield* syncPass(config);
        assertNoWrites(yield* syncPass(config));

        for (const [filePath, content] of Object.entries(untouched)) {
          assert.strictEqual(yield* read(filePath), content);
        }
        // Nothing unmapped was imported into the vault.
        const fs = yield* FileSystem.FileSystem;
        const vaultFiles = yield* fs.readDirectory(vaultDir, { recursive: true });
        assert.deepStrictEqual(vaultFiles.filter((name) => name.endsWith(".md")).sort(), [
          "Daily/2026-07-18.md",
        ]);
      }),
    ),
  );

  it.effect("deletions are never propagated and tombstones prevent resurrection", () =>
    run(
      Effect.gen(function* () {
        const { config, notePlanDir, vaultDir } = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const vaultPath = `${vaultDir}/Daily/2026-07-18.md`;
        const notePlanPath = `${notePlanDir}/Calendar/20260718.md`;
        yield* write(vaultPath, "- [ ] doomed\n");
        yield* syncPass(config);

        // Delete the vault copy: NotePlan data must survive.
        yield* fs.remove(vaultPath);
        yield* syncPass(config);
        assert.isTrue(yield* exists(notePlanPath));
        // ...and the deleted vault file is not resurrected by later passes.
        assertNoWrites(yield* syncPass(config));
        assert.isFalse(yield* exists(vaultPath));

        // Editing the surviving NotePlan copy revives the pair.
        yield* write(notePlanPath, "- [x] doomed\n");
        yield* syncPass(config);
        assert.isTrue(yield* exists(vaultPath));
        assert.include(yield* read(vaultPath), "- [x] doomed");
      }),
    ),
  );

  it.effect("project notes mirror into the bridge-owned Notes namespace", () =>
    run(
      Effect.gen(function* () {
        const { config, notePlanDir, vaultDir } = yield* makeFixture({
          mirrorFolders: ["Projects"],
        });
        const vaultPath = `${vaultDir}/Projects/Errands.md`;
        const notePlanPath = `${notePlanDir}/Notes/Apna/Projects/Errands.md`;
        yield* write(vaultPath, "---\ntitle: Errands\n---\n- [ ] renew passport 📅 2026-09-01\n");

        yield* syncPass(config);
        assert.strictEqual(yield* read(notePlanPath), "- [ ] renew passport >2026-09-01\n");

        yield* write(notePlanPath, "- [x] renew passport >2026-09-01 @done(2026-09-01)\n");
        yield* syncPass(config);
        const vaultContent = yield* read(vaultPath);
        assert.isTrue(vaultContent.startsWith("---\ntitle: Errands\n---\n"));
        assert.include(vaultContent, "- [x] renew passport 📅 2026-09-01 ✅ 2026-09-01");
        assertNoWrites(yield* syncPass(config));
      }),
    ),
  );

  it.effect("dry-run reports planned writes without touching anything", () =>
    run(
      Effect.gen(function* () {
        const { config, notePlanDir, vaultDir } = yield* makeFixture();
        yield* write(`${vaultDir}/Daily/2026-07-18.md`, "- [ ] task\n");
        const result = yield* syncPass(config, { dryRun: true });
        assert.strictEqual(result.writes, 1);
        assert.isFalse(yield* exists(`${notePlanDir}/Calendar/20260718.md`));
        assert.isFalse(yield* exists(config.ledgerPath));
      }),
    ),
  );

  it.effect("a full day of dual edits across passes produces no duplicate lines", () =>
    run(
      Effect.gen(function* () {
        const { config, notePlanDir, vaultDir } = yield* makeFixture();
        const vaultPath = `${vaultDir}/Daily/2026-07-18.md`;
        const notePlanPath = `${notePlanDir}/Calendar/20260718.md`;
        yield* write(vaultPath, "- [ ] a\n- [ ] b\n");
        yield* syncPass(config);

        // Morning: add a task in NotePlan.
        yield* write(notePlanPath, "- [ ] a\n- [ ] b\n- [ ] c\n");
        yield* syncPass(config);
        // Midday: complete a task in the vault (Obsidian edit).
        yield* write(vaultPath, (yield* read(vaultPath)).replace("- [ ] a", "- [x] a"));
        yield* syncPass(config);
        // Evening: complete another in NotePlan.
        yield* write(notePlanPath, (yield* read(notePlanPath)).replace("- [ ] c", "- [x] c"));
        yield* syncPass(config);
        assertNoWrites(yield* syncPass(config));

        const finalVault = yield* read(vaultPath);
        const finalNotePlan = yield* read(notePlanPath);
        for (const title of ["a", "b", "c"]) {
          assert.strictEqual(
            finalVault.split(`] ${title}`).length - 1,
            1,
            `vault has exactly one "${title}"`,
          );
          assert.strictEqual(
            finalNotePlan.split(`] ${title}`).length - 1,
            1,
            `noteplan has exactly one "${title}"`,
          );
        }
        assert.include(finalVault, "- [x] a");
        assert.include(finalVault, "- [x] c");
        assert.include(finalNotePlan, "- [x] a");
        assert.include(finalNotePlan, "- [x] c");
      }),
    ),
  );
});
