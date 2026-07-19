#!/usr/bin/env node

// Regenerates the committed @mark/editor package in the sibling Mark repo:
// compiled JS + .d.ts + styles + a generated package.json under
// <editor-dir>/dist.
//
// Staleness workflow: edit Mark, run `node scripts/build-mark-editor.ts`,
// commit and push Mark's dist, bump the pinned commit in apps/web/package.json,
// then run `vp install` here to refresh the Git dependency.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

const DEFAULT_MARK_EDITOR_DIR = "/Users/kota/Documents/Life/Mark/packages/editor";

export class MarkEditorBuildError extends Schema.TaggedErrorClass<MarkEditorBuildError>()(
  "MarkEditorBuildError",
  {
    operation: Schema.Literals([
      "read-manifest",
      "decode-manifest",
      "locate-tsc",
      "clean",
      "compile-spawn",
      "compile-communicate",
      "compile-exit",
      "copy-styles",
      "write-manifest",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to build @mark/editor (${this.operation}): ${this.detail}`;
  }
}

const MarkEditorSourceManifestSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type MarkEditorSourceManifest = typeof MarkEditorSourceManifestSchema.Type;

const SourceManifestJson = fromJsonStringPretty(MarkEditorSourceManifestSchema);
const decodeSourceManifest = Schema.decodeUnknownEffect(SourceManifestJson);

const DistManifestJson = fromJsonStringPretty(Schema.Record(Schema.String, Schema.Unknown));
const encodeDistManifest = Schema.encodeEffect(DistManifestJson);

/**
 * The package.json emitted next to the compiled output. Runtime
 * dependencies and peers are carried over verbatim; entry points switch
 * from TypeScript source to the compiled JS + declarations.
 */
export function buildMarkEditorDistManifest(
  source: MarkEditorSourceManifest,
): Record<string, unknown> {
  return {
    name: source.name,
    version: source.version,
    private: true,
    type: "module",
    description:
      "Generated build output of @mark/editor. Do not edit; regenerate with scripts/build-mark-editor.ts in apna-tasks.",
    exports: {
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
      "./styles.css": "./styles.css",
    },
    ...(source.dependencies ? { dependencies: source.dependencies } : {}),
    ...(source.peerDependencies ? { peerDependencies: source.peerDependencies } : {}),
  };
}

/**
 * tsconfig used for the emit. Extends the editor package's own tsconfig so
 * compiler behavior follows Mark, overriding only emit-related options.
 * All paths are absolute so the file can live in a temporary directory.
 */
export function buildMarkEditorEmitTsconfig(editorDir: string): Record<string, unknown> {
  return {
    extends: `${editorDir}/tsconfig.json`,
    compilerOptions: {
      noEmit: false,
      declaration: true,
      declarationMap: false,
      sourceMap: false,
      outDir: `${editorDir}/dist`,
      rootDir: `${editorDir}/src`,
      types: [],
    },
    include: [`${editorDir}/src`],
  };
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const locateTsc = Effect.fn("locateTsc")(function* (editorDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates = [
    path.join(editorDir, "node_modules", ".bin", "tsc"),
    path.join(editorDir, "..", "..", "node_modules", ".bin", "tsc"),
  ];
  for (const candidate of candidates) {
    const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return yield* new MarkEditorBuildError({
    operation: "locate-tsc",
    detail: `No tsc binary found. Looked in: ${candidates.join(", ")}. Run the Mark repo's package install first.`,
  });
});

const compileMarkEditor = Effect.fn("compileMarkEditor")(function* (
  editorDir: string,
  tscPath: string,
  tsconfigPath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(ChildProcess.make(tscPath, ["-p", tsconfigPath], { cwd: editorDir }))
    .pipe(
      Effect.mapError(
        (cause) => new MarkEditorBuildError({ operation: "compile-spawn", detail: tscPath, cause }),
      ),
    );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new MarkEditorBuildError({ operation: "compile-communicate", detail: tscPath, cause }),
    ),
  );

  if (exitCode !== 0) {
    return yield* new MarkEditorBuildError({
      operation: "compile-exit",
      detail: `tsc exited with code ${exitCode}:\n${stdout}\n${stderr}`.trim(),
    });
  }
});

export const buildMarkEditor = Effect.fn("buildMarkEditor")(function* (editorDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const distDir = path.join(editorDir, "dist");

  const manifestPath = path.join(editorDir, "package.json");
  const manifestText = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.mapError(
        (cause) =>
          new MarkEditorBuildError({ operation: "read-manifest", detail: manifestPath, cause }),
      ),
    );
  const sourceManifest = yield* decodeSourceManifest(manifestText).pipe(
    Effect.mapError(
      (cause) =>
        new MarkEditorBuildError({ operation: "decode-manifest", detail: manifestPath, cause }),
    ),
  );

  const tscPath = yield* locateTsc(editorDir);

  yield* fs
    .remove(distDir, { recursive: true, force: true })
    .pipe(
      Effect.mapError(
        (cause) => new MarkEditorBuildError({ operation: "clean", detail: distDir, cause }),
      ),
    );

  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "mark-editor-build-" });
  const tsconfigPath = path.join(tempDir, "tsconfig.emit.json");
  const tsconfigText = yield* encodeDistManifest(buildMarkEditorEmitTsconfig(editorDir)).pipe(
    Effect.mapError(
      (cause) =>
        new MarkEditorBuildError({ operation: "write-manifest", detail: tsconfigPath, cause }),
    ),
  );
  yield* fs
    .writeFileString(tsconfigPath, `${tsconfigText}\n`)
    .pipe(
      Effect.mapError(
        (cause) =>
          new MarkEditorBuildError({ operation: "write-manifest", detail: tsconfigPath, cause }),
      ),
    );

  yield* Console.log(`Compiling ${sourceManifest.name}@${sourceManifest.version} to ${distDir}`);
  yield* compileMarkEditor(editorDir, tscPath, tsconfigPath).pipe(Effect.scoped);

  yield* fs
    .copyFile(path.join(editorDir, "src", "styles.css"), path.join(distDir, "styles.css"))
    .pipe(
      Effect.mapError(
        (cause) => new MarkEditorBuildError({ operation: "copy-styles", detail: distDir, cause }),
      ),
    );

  const distManifestPath = path.join(distDir, "package.json");
  const distManifestText = yield* encodeDistManifest(
    buildMarkEditorDistManifest(sourceManifest),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new MarkEditorBuildError({ operation: "write-manifest", detail: distManifestPath, cause }),
    ),
  );
  yield* fs.writeFileString(distManifestPath, `${distManifestText}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new MarkEditorBuildError({
          operation: "write-manifest",
          detail: distManifestPath,
          cause,
        }),
    ),
  );

  yield* Console.log(`Built ${sourceManifest.name} into ${distDir}`);
});

export const buildMarkEditorCommand = Command.make(
  "build-mark-editor",
  {
    editorDir: Flag.string("editor-dir").pipe(
      Flag.withDescription("Path to the Mark repo's packages/editor directory."),
      Flag.optional,
    ),
  },
  ({ editorDir }) =>
    buildMarkEditor(Option.getOrElse(editorDir, () => DEFAULT_MARK_EDITOR_DIR)).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Build @mark/editor from the sibling Mark repository into an installable dist package.",
  ),
);

if (import.meta.main) {
  Command.run(buildMarkEditorCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
