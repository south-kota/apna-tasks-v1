import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { defaultConfig } from "./Config.ts";
import { makeIndex } from "./Index.ts";

const nodeServicesIt = it.layer(NodeServices.layer);

/** Synthetic fixture vault — no real vault content (the repo is public). */
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "projects/demo/project.md": `---
type: project
id: project-demo
title: Demo Project
status: active
tags:
  - fixture
---

# Demo Project

See [[I-01-00-overhaul]] for the main task.
`,
  "projects/demo/TODO.md": `---
type: note
id: note-demo-todo
title: Demo TODO
---

# TODO

- [ ] 01-00 doing [Overhaul the flow](tasks/I-01-00-overhaul.md)
- [x] 01-01 done [Audit paths](tasks/O-01-01-audit.md)
- [ ] plain checklist item
`,
  "projects/demo/tasks/I-01-00-overhaul.md": `---
type: task
id: task-overhaul
title: Overhaul the flow
status: doing
sequence: 01-00
project: project-demo
due: 2026-08-01
assignees:
  - kota
custom_field: preserved
---

# Overhaul the flow

Work happens here. #focus
`,
  "projects/demo/tasks/O-01-01-audit.md": `---
type: task
id: task-audit
title: Audit paths
status: done
sequence: 01-01
project: project-demo
parent: task-overhaul
completed: 2026-07-01
---
`,
  "projects/demo/notes/research.md": `---
type: note
id: note-research
title: Research
tags: [deep]
---

Links back to [the project](../project.md) and [[O-01-01-audit|the audit]].
Inline #research tag.
`,
  "journal/2026-07-18.md": `---
type: journal
id: journal-2026-07-18
title: 2026-07-18
date: 2026-07-18
---

Worked on [[I-01-00-overhaul]].
`,
  "views/open-tasks.md": `---
type: collection
id: collection-open-tasks
title: Open Tasks
query:
  types: [task]
  status: [todo, doing]
---
`,
  "loose-plain-note.md": `# Plain note

No frontmatter at all, just markdown. #plain
`,
  "broken/bad-yaml.md": `---
title: [unclosed
---
body
`,
  "broken/bad-status.md": `---
type: task
id: task-bad-status
title: Bad status
status: someday
---
`,
  "broken/duplicate-id.md": `---
type: task
id: task-overhaul
title: Imposter
status: todo
---
`,
};

const writeFixtureVault = Effect.fn("writeFixtureVault")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relative, contents] of Object.entries(FIXTURE_FILES)) {
    const absolute = path.join(root, ...relative.split("/"));
    yield* fs.makeDirectory(path.dirname(absolute), { recursive: true });
    yield* fs.writeFileString(absolute, contents);
  }
  // Ignored locations must never be indexed.
  yield* fs.makeDirectory(path.join(root, "node_modules", "pkg"), { recursive: true });
  yield* fs.writeFileString(path.join(root, "node_modules", "pkg", "x.md"), "# ignored\n");
  yield* fs.makeDirectory(path.join(root, ".obsidian"), { recursive: true });
  yield* fs.writeFileString(path.join(root, ".obsidian", "notes.md"), "# ignored\n");
});

const makeFixtureIndex = Effect.fn("makeFixtureIndex")(function* (options?: {
  readonly dbPath?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const vault = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-index-" });
  yield* writeFixtureVault(vault);
  const index = yield* makeIndex({
    vaultRoot: vault,
    config: defaultConfig,
    dbPath: options?.dbPath ?? ":memory:",
  });
  yield* index.rebuild();
  return { vault, index };
});

describe("JbomIndex", () => {
  nodeServicesIt("node services", (it) => {
    it.effect("indexes the vault and reports stats", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { index } = yield* makeFixtureIndex();
          const stats = yield* index.stats();
          assert.strictEqual(stats.files, 11);
          assert.strictEqual(stats.tasks, 4);
          assert.strictEqual(stats.openTasks, 2); // overhaul (doing) + duplicate (todo)
          assert.isAtLeast(stats.errors, 3); // bad yaml is untyped; bad status + duplicate id
        }),
      ),
    );

    it.effect("answers task queries correctly", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { index } = yield* makeFixtureIndex();

          const open = yield* index.listTasks({ open: true });
          assert.deepStrictEqual(
            open.map((task) => task.id),
            ["task-overhaul", "task-overhaul"],
          ); // fixture includes a deliberate duplicate id

          const doing = yield* index.listTasks({ statuses: ["doing"] });
          assert.deepStrictEqual(
            doing.map((task) => task.path),
            ["projects/demo/tasks/I-01-00-overhaul.md"],
          );
          assert.strictEqual(doing[0]?.due, "2026-08-01");
          assert.deepStrictEqual(doing[0]?.assignees, ["kota"]);
          assert.strictEqual(doing[0]?.frontmatter["custom_field"], "preserved");

          const closed = yield* index.listTasks({ open: false });
          assert.deepStrictEqual(
            closed.map((task) => task.id),
            ["task-audit"],
          );
          assert.strictEqual(closed[0]?.parent, "task-overhaul");

          const dueSoon = yield* index.listTasks({ dueOnOrBefore: "2026-08-01" });
          assert.strictEqual(dueSoon.length, 1);
        }),
      ),
    );

    it.effect("filters records by type, tag, and validity", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { index } = yield* makeFixtureIndex();

          const projects = yield* index.listRecords({ type: "project" });
          assert.deepStrictEqual(
            projects.map((record) => record.id),
            ["project-demo"],
          );

          const tagged = yield* index.listRecords({ tag: "research" });
          assert.deepStrictEqual(
            tagged.map((record) => record.path),
            ["projects/demo/notes/research.md"],
          );

          const validTasks = yield* index.listRecords({ type: "task", validOnly: true });
          assert.deepStrictEqual(validTasks.map((record) => record.id).sort(), [
            "task-audit",
            "task-overhaul",
            "task-overhaul",
          ]); // duplicate ids stay indexed; the duplicate-id error is a vault-level diagnostic

          const plain = yield* index.getRecord("loose-plain-note.md");
          assert.isFalse(plain?.recognizedType);
          assert.deepStrictEqual(plain?.tags, ["plain"]);
        }),
      ),
    );

    it.effect("resolves links (markdown + wiki) and backlinks", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { index } = yield* makeFixtureIndex();

          const fromResearch = yield* index.linksFrom("projects/demo/notes/research.md");
          assert.deepStrictEqual(
            fromResearch.map((link) => link.targetPath),
            ["projects/demo/tasks/O-01-01-audit.md", "projects/demo/project.md"],
          );

          const backlinks = yield* index.backlinksOf("projects/demo/tasks/I-01-00-overhaul.md");
          assert.deepStrictEqual(backlinks.map((link) => link.sourcePath).sort(), [
            "journal/2026-07-18.md",
            "projects/demo/TODO.md",
            "projects/demo/project.md",
          ]);
        }),
      ),
    );

    it.effect("recognizes task references per spec ch. 10", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { index } = yield* makeFixtureIndex();
          const refs = yield* index.listTaskRefs({ sourcePath: "projects/demo/TODO.md" });
          assert.strictEqual(refs.length, 3);
          const [first, second, third] = refs;
          assert.isTrue(first?.isTaskReference);
          assert.strictEqual(first?.statusToken, "doing");
          assert.strictEqual(first?.sequence, "01-00");
          assert.strictEqual(first?.targetPath, "projects/demo/tasks/I-01-00-overhaul.md");
          assert.isTrue(second?.isTaskReference);
          assert.isTrue(second?.checked);
          assert.isFalse(third?.isTaskReference);
          assert.isUndefined(third?.targetPath);
        }),
      ),
    );

    it.effect("reports diagnostics without destroying records", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { index } = yield* makeFixtureIndex();

          const errors = yield* index.listDiagnostics({ severity: "error" });
          const codes = new Set(errors.map((d) => d.code));
          assert.isTrue(codes.has("frontmatter-parse-error"));
          assert.isTrue(codes.has("invalid-field-value"));
          const duplicatePaths = errors
            .filter((d) => d.code === "duplicate-id")
            .map((d) => d.path)
            .sort();
          assert.deepStrictEqual(duplicatePaths, [
            "broken/duplicate-id.md",
            "projects/demo/tasks/I-01-00-overhaul.md",
          ]);

          // The invalid records are still indexed.
          const badStatus = yield* index.getRecord("broken/bad-status.md");
          assert.isDefined(badStatus);
          assert.isFalse(badStatus?.valid);
          assert.strictEqual(badStatus?.frontmatter["status"], "someday");
        }),
      ),
    );

    it.effect("deleting the database and rebuilding is lossless", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const vault = yield* fs.makeTempDirectoryScoped({ prefix: "jbom-lossless-" });
          yield* writeFixtureVault(vault);
          const dbPath = path.join(vault, ".jbom", "index.sqlite");

          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const index = yield* makeIndex({ vaultRoot: vault, config: defaultConfig, dbPath });
              yield* index.rebuild();
              return yield* index.dump();
            }),
          );

          // Canonical recovery path: delete the database, rebuild from markdown.
          yield* fs.remove(dbPath, { force: true });
          yield* fs
            .remove(`${dbPath}-wal`, { force: true })
            .pipe(Effect.orElseSucceed(() => undefined));
          yield* fs
            .remove(`${dbPath}-shm`, { force: true })
            .pipe(Effect.orElseSucceed(() => undefined));

          const second = yield* Effect.scoped(
            Effect.gen(function* () {
              const index = yield* makeIndex({ vaultRoot: vault, config: defaultConfig, dbPath });
              yield* index.rebuild();
              return yield* index.dump();
            }),
          );

          assert.strictEqual(second, first);
          assert.isAbove(first.length, 100);
        }),
      ),
    );

    it.effect("incremental applyEvents converges with a full rebuild", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { vault, index } = yield* makeFixtureIndex();

          // Create a new task, edit an existing one, remove a note.
          yield* fs.writeFileString(
            path.join(vault, "projects", "demo", "tasks", "I-01-02-new.md"),
            "---\ntype: task\nid: task-new\ntitle: New Task\nstatus: todo\n---\n",
          );
          const overhaulPath = path.join(vault, "projects", "demo", "tasks", "I-01-00-overhaul.md");
          const overhaul = yield* fs.readFileString(overhaulPath);
          yield* fs.writeFileString(
            overhaulPath,
            overhaul.replace("status: doing", "status: blocked"),
          );
          yield* fs.remove(path.join(vault, "projects", "demo", "notes", "research.md"));

          yield* index.applyEvents([
            { kind: "created", path: "projects/demo/tasks/I-01-02-new.md" },
            { kind: "updated", path: "projects/demo/tasks/I-01-00-overhaul.md" },
            { kind: "removed", path: "projects/demo/notes/research.md" },
          ]);
          const incremental = yield* index.dump();

          const fresh = yield* Effect.scoped(
            Effect.gen(function* () {
              const rebuilt = yield* makeIndex({
                vaultRoot: vault,
                config: defaultConfig,
                dbPath: ":memory:",
              });
              yield* rebuilt.rebuild();
              return yield* rebuilt.dump();
            }),
          );

          assert.strictEqual(incremental, fresh);

          const blocked = yield* index.listTasks({ statuses: ["blocked"] });
          assert.deepStrictEqual(
            blocked.map((task) => task.id),
            ["task-overhaul"],
          );
        }),
      ),
    );
  });
});
