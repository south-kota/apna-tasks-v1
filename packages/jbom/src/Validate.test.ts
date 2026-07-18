import { assert, describe, it } from "@effect/vitest";

import { defaultConfig } from "./Config.ts";
import { parse } from "./Frontmatter.ts";
import { scanBody } from "./Markdown.ts";
import type { RecordAnalysis } from "./Model.ts";
import { analyzeRecord, mintId } from "./Validate.ts";

const analyze = (path: string, source: string): RecordAnalysis => {
  const parsed = parse(source);
  const scan = scanBody(parsed.body, parsed.frontmatter?.lineCount ?? 0);
  return analyzeRecord({ path, parsed, scan, types: defaultConfig.types });
};

describe("Validate.analyzeRecord", () => {
  it("accepts a minimal valid task", () => {
    const analysis = analyze(
      "tasks/demo.md",
      "---\ntype: task\nid: task-demo\ntitle: Demo\nstatus: todo\n---\n",
    );
    assert.isTrue(analysis.valid);
    assert.strictEqual(analysis.type, "task");
    assert.strictEqual(analysis.task?.status, "todo");
    assert.deepStrictEqual(analysis.diagnostics, []);
  });

  it("treats files without a type as plain markdown, with no diagnostics", () => {
    const analysis = analyze("notes/plain.md", "# Just a note\n\nHello.\n");
    assert.isUndefined(analysis.type);
    assert.isFalse(analysis.recognizedType);
    assert.isFalse(analysis.valid);
    assert.deepStrictEqual(analysis.diagnostics, []);
    assert.strictEqual(analysis.title, "Just a note");
  });

  it("keeps unknown types as unvalidated custom records", () => {
    const analysis = analyze("spec.md", "---\ntype: spec\nname: My Spec\n---\n");
    assert.strictEqual(analysis.type, "spec");
    assert.isFalse(analysis.recognizedType);
    assert.deepStrictEqual(analysis.diagnostics, []);
    assert.strictEqual(analysis.title, "My Spec");
  });

  it("reports a missing required field as a readable error", () => {
    const analysis = analyze("tasks/broken.md", "---\ntype: task\nid: t1\ntitle: x\n---\n");
    assert.isFalse(analysis.valid);
    const error = analysis.diagnostics.find((d) => d.code === "missing-required-field");
    assert.strictEqual(error?.severity, "error");
    assert.include(error?.message ?? "", "`status`");
  });

  it("reports unknown status values with the allowed set", () => {
    const analysis = analyze(
      "tasks/bad-status.md",
      "---\ntype: task\nid: t1\ntitle: x\nstatus: in-progress\n---\n",
    );
    assert.isFalse(analysis.valid);
    const error = analysis.diagnostics.find((d) => d.field === "status");
    assert.include(error?.message ?? "", "todo, doing, waiting, blocked, done, canceled");
  });

  it("warns on missing id and derives titles leniently", () => {
    const analysis = analyze("notes/untitled.md", "---\ntype: note\n---\n# Derived Title\n");
    assert.isTrue(analysis.valid);
    assert.strictEqual(analysis.title, "Derived Title");
    const codes = analysis.diagnostics.map((d) => d.code).sort();
    assert.deepStrictEqual(codes, ["missing-id", "missing-title"]);
    assert.isTrue(analysis.diagnostics.every((d) => d.severity === "warning"));
  });

  it("accepts `name` as a title alias with a warning", () => {
    const analysis = analyze("notes/named.md", "---\ntype: note\nname: Named Note\n---\n");
    assert.strictEqual(analysis.title, "Named Note");
    assert.isTrue(analysis.diagnostics.some((d) => d.code === "title-from-name-alias"));
  });

  it("validates journals require a date", () => {
    const invalid = analyze("journal/x.md", "---\ntype: journal\ntitle: x\n---\n");
    assert.isFalse(invalid.valid);
    const valid = analyze(
      "journal/2026-07-18.md",
      "---\ntype: journal\nid: j1\ntitle: x\ndate: 2026-07-18\n---\n",
    );
    assert.isTrue(valid.valid);
  });

  it("validates collections need query or items", () => {
    const invalid = analyze("views/empty.md", "---\ntype: collection\nid: c1\ntitle: x\n---\n");
    assert.isFalse(invalid.valid);
    const withQuery = analyze(
      "views/open.md",
      "---\ntype: collection\nid: c2\ntitle: x\nquery:\n  types: [task]\n---\n",
    );
    assert.isTrue(withQuery.valid);
    const withItems = analyze(
      "views/handpicked.md",
      "---\ntype: collection\nid: c3\ntitle: x\nitems:\n  - task-one\n---\n",
    );
    assert.isTrue(withItems.valid);
  });

  it("flags malformed dates and wrong field shapes", () => {
    const analysis = analyze(
      "tasks/bad-due.md",
      "---\ntype: task\nid: t1\ntitle: x\nstatus: todo\ndue: someday\n---\n",
    );
    assert.isFalse(analysis.valid);
    assert.isTrue(analysis.diagnostics.some((d) => d.field === "due" && d.severity === "error"));
  });

  it("accepts YAML date values for date fields", () => {
    const analysis = analyze(
      "tasks/dated.md",
      "---\ntype: task\nid: t1\ntitle: x\nstatus: todo\ndue: 2026-05-20\n---\n",
    );
    assert.isTrue(analysis.valid);
    assert.strictEqual(analysis.task?.due, "2026-05-20");
  });

  it("warns when I-/O- filename prefixes disagree with status", () => {
    const analysis = analyze(
      "tasks/I-01-01-finished.md",
      "---\ntype: task\nid: t1\ntitle: x\nstatus: done\n---\n",
    );
    assert.isTrue(analysis.valid);
    assert.isTrue(analysis.diagnostics.some((d) => d.code === "filename-status-drift"));
  });

  it("merges frontmatter and inline tags", () => {
    const analysis = analyze(
      "notes/tagged.md",
      "---\ntype: note\nid: n1\ntitle: x\ntags:\n  - alpha\n---\nInline #beta here\n",
    );
    assert.deepStrictEqual([...analysis.tags].sort(), ["alpha", "beta"]);
  });

  it("preserves unknown frontmatter fields in the analysis", () => {
    const analysis = analyze(
      "notes/custom.md",
      "---\ntype: note\nid: n1\ntitle: x\nmy_custom: [1, 2]\n---\n",
    );
    assert.deepStrictEqual(analysis.frontmatter["my_custom"], [1, 2]);
    assert.isTrue(analysis.valid);
  });

  it("reports invalid YAML as an error diagnostic", () => {
    const analysis = analyze("notes/broken.md", "---\ntitle: [unclosed\n---\nbody\n");
    assert.isTrue(
      analysis.diagnostics.some(
        (d) => d.code === "frontmatter-parse-error" && d.severity === "error",
      ),
    );
  });
});

describe("Validate.mintId", () => {
  it("mints type-prefixed slugs", () => {
    assert.strictEqual(mintId("task", "Redesign the Reset Flow!"), "task-redesign-the-reset-flow");
    assert.strictEqual(mintId("note", "Café — Notes"), "note-cafe-notes");
    assert.strictEqual(mintId("task", "!!!"), "task");
  });
});
