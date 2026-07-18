import { describe, expect, it } from "vite-plus/test";

import { buildMarkEditorDistManifest, buildMarkEditorEmitTsconfig } from "./build-mark-editor.ts";

describe("buildMarkEditorDistManifest", () => {
  const source = {
    name: "@mark/editor",
    version: "0.0.1",
    dependencies: {
      "@atomic-editor/editor": "0.6.2",
      "@codemirror/state": "^6.0.0",
    },
    peerDependencies: {
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    },
  };

  it("points entry points at compiled output instead of TypeScript source", () => {
    expect(buildMarkEditorDistManifest(source)["exports"]).toEqual({
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
      "./styles.css": "./styles.css",
    });
  });

  it("carries over runtime and peer dependencies verbatim, without dev dependencies", () => {
    const manifest = buildMarkEditorDistManifest(source);
    expect(manifest["name"]).toBe("@mark/editor");
    expect(manifest["version"]).toBe("0.0.1");
    expect(manifest["dependencies"]).toEqual(source.dependencies);
    expect(manifest["peerDependencies"]).toEqual(source.peerDependencies);
    expect(manifest).not.toHaveProperty("devDependencies");
    expect(manifest).not.toHaveProperty("scripts");
  });

  it("omits dependency sections that the source manifest does not declare", () => {
    const manifest = buildMarkEditorDistManifest({ name: "@mark/editor", version: "0.0.1" });
    expect(manifest).not.toHaveProperty("dependencies");
    expect(manifest).not.toHaveProperty("peerDependencies");
  });
});

describe("buildMarkEditorEmitTsconfig", () => {
  it("extends the package tsconfig and re-enables emit with declarations", () => {
    const tsconfig = buildMarkEditorEmitTsconfig("/mark/packages/editor");
    expect(tsconfig["extends"]).toBe("/mark/packages/editor/tsconfig.json");
    expect(tsconfig["compilerOptions"]).toMatchObject({
      noEmit: false,
      declaration: true,
      outDir: "/mark/packages/editor/dist",
      rootDir: "/mark/packages/editor/src",
    });
    expect(tsconfig["include"]).toEqual(["/mark/packages/editor/src"]);
  });
});
