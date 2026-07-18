/**
 * `jbom` command line: rebuild the index, check a vault, query tasks, and
 * export a vault to JSON. Run with `node src/cli.ts <command>` (or via the
 * package script `vp run --filter @t3tools/jbom cli`).
 *
 * @module cli
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import { loadConfig } from "./Config.ts";
import { exportVault } from "./Export.ts";
import { writeFileAtomic } from "./FileOps.ts";
import { type JbomIndex, makeIndex } from "./Index.ts";
import { TASK_STATUSES } from "./Model.ts";

/**
 * The CLI's outputs are ad-hoc JSON views of already-validated data, so a
 * plain stringify helper (outside Effect code) is intentional here.
 */
const toPrettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

const vaultFlag = Flag.string("vault").pipe(
  Flag.withDescription("Vault root directory"),
  Flag.withDefault("."),
);

const withIndex = <A, E>(
  vault: string,
  body: (index: JbomIndex["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* loadConfig(vault);
      const index = yield* makeIndex({ vaultRoot: vault, config });
      yield* index.rebuild();
      return yield* body(index);
    }),
  );

const rebuild = Command.make(
  "rebuild",
  { vault: vaultFlag },
  Effect.fn(function* ({ vault }) {
    yield* withIndex(vault, (index) =>
      Effect.gen(function* () {
        const stats = yield* index.stats();
        yield* Console.log(toPrettyJson(stats));
      }),
    );
  }),
).pipe(Command.withDescription("Rebuild the SQLite index from the Markdown corpus"));

const check = Command.make(
  "check",
  {
    vault: vaultFlag,
    errorsOnly: Flag.boolean("errors-only").pipe(
      Flag.withDescription("Only report error-severity diagnostics"),
    ),
  },
  Effect.fn(function* ({ vault, errorsOnly }) {
    yield* withIndex(vault, (index) =>
      Effect.gen(function* () {
        const diagnostics = yield* index.listDiagnostics(
          errorsOnly ? { severity: "error" } : undefined,
        );
        for (const diagnostic of diagnostics) {
          yield* Console.log(
            `${diagnostic.severity === "error" ? "ERROR" : "warn "} ${diagnostic.path}: ${diagnostic.message}`,
          );
        }
        const stats = yield* index.stats();
        yield* Console.log(
          `${stats.files} files, ${stats.typedRecords} typed, ${stats.validRecords} valid, ${stats.errors} errors, ${stats.diagnostics - stats.errors} warnings`,
        );
      }),
    );
  }),
).pipe(Command.withDescription("Validate the vault and print diagnostics"));

const tasks = Command.make(
  "tasks",
  {
    vault: vaultFlag,
    status: Flag.choice("status", [...TASK_STATUSES, "open", "closed", "all"]).pipe(
      Flag.withDescription("Filter by task status"),
      Flag.withDefault("open"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Print JSON instead of a listing")),
  },
  Effect.fn(function* ({ vault, status, json }) {
    yield* withIndex(vault, (index) =>
      Effect.gen(function* () {
        const filter =
          status === "all"
            ? undefined
            : status === "open"
              ? { open: true }
              : status === "closed"
                ? { open: false }
                : { statuses: [status] };
        const rows = yield* index.listTasks(filter);
        if (json) {
          yield* Console.log(toPrettyJson(rows));
          return;
        }
        for (const task of rows) {
          const sequence = task.sequence === undefined ? "" : `${task.sequence} `;
          const due = task.due === undefined ? "" : ` (due ${task.due})`;
          yield* Console.log(
            `[${task.status ?? "?"}] ${sequence}${task.title ?? task.path}${due} — ${task.path}`,
          );
        }
      }),
    );
  }),
).pipe(Command.withDescription("List tasks from the index"));

const exportCommand = Command.make(
  "export",
  {
    vault: vaultFlag,
    out: Flag.string("out").pipe(
      Flag.withDescription("Output file (stdout when omitted)"),
      Flag.optional,
    ),
    noBody: Flag.boolean("no-body").pipe(Flag.withDescription("Omit Markdown bodies")),
  },
  Effect.fn(function* ({ vault, out, noBody }) {
    const config = yield* loadConfig(vault);
    const result = yield* exportVault({ vaultRoot: vault, config, includeBody: !noBody });
    const text = toPrettyJson(result);
    if (out._tag === "Some") {
      yield* writeFileAtomic(out.value, `${text}\n`);
      yield* Console.log(`Wrote ${result.fileCount} records to ${out.value}`);
    } else {
      yield* Console.log(text);
    }
  }),
).pipe(Command.withDescription("Export the vault as JSON records"));

Command.make("jbom").pipe(
  Command.withDescription("JBOM vault engine"),
  Command.withSubcommands([rebuild, check, tasks, exportCommand]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
