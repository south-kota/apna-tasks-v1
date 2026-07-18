import { assert, describe, it } from "@effect/vitest";

import { parse, serialize, updateFrontmatter } from "./Frontmatter.ts";

const roundTrips = (source: string) => {
  assert.strictEqual(serialize(parse(source)), source);
};

describe("Frontmatter.parse/serialize", () => {
  it("round-trips a typical record byte-for-byte", () => {
    roundTrips(`---
type: task
id: task-demo
title: Demo
status: todo
---

# Demo

Body text.
`);
  });

  it("round-trips plain markdown with no frontmatter", () => {
    roundTrips("# Just a note\n\nNo frontmatter here.\n");
    roundTrips("");
    roundTrips("---broken fence, not frontmatter\n");
  });

  it("round-trips CRLF files byte-for-byte", () => {
    roundTrips("---\r\ntype: note\r\ntitle: CRLF\r\n---\r\n\r\nBody\r\n");
  });

  it("round-trips files without a trailing newline", () => {
    roundTrips("---\ntype: note\ntitle: x\n---\nbody without newline");
    roundTrips("---\ntype: note\n---");
  });

  it("round-trips invalid YAML untouched and reports the problem", () => {
    const source = "---\ntitle: [unclosed\n---\nbody\n";
    const parsed = parse(source);
    assert.strictEqual(serialize(parsed), source);
    assert.isDefined(parsed.frontmatter);
    assert.isUndefined(parsed.frontmatter?.data);
    assert.include(parsed.frontmatter?.parseError ?? "", "Invalid YAML");
  });

  it("round-trips unknown fields, comments, and odd spacing", () => {
    roundTrips(`---
type: note
# a human comment
custom_field:   weird   spacing
nested:
  deep:
    - 1
    - 2
unknown_list: [a, b,   c]
---
body
`);
  });

  it("treats an unclosed fence as body", () => {
    const source = "---\ntype: note\nno closing fence\n";
    const parsed = parse(source);
    assert.isUndefined(parsed.frontmatter);
    assert.strictEqual(serialize(parsed), source);
  });

  it("parses fields and body boundaries correctly", () => {
    const parsed = parse("---\ntype: task\nstatus: todo\n---\nBody line\n");
    assert.deepStrictEqual(parsed.frontmatter?.data, { type: "task", status: "todo" });
    assert.strictEqual(parsed.body, "Body line\n");
    assert.strictEqual(parsed.frontmatter?.lineCount, 4);
  });

  it("rejects non-mapping frontmatter without destroying it", () => {
    const source = "---\n- just\n- a list\n---\nbody\n";
    const parsed = parse(source);
    assert.isUndefined(parsed.frontmatter?.data);
    assert.include(parsed.frontmatter?.parseError ?? "", "mapping");
    assert.strictEqual(serialize(parsed), source);
  });
});

describe("Frontmatter.updateFrontmatter", () => {
  it("updates a field while preserving unknown fields, comments, and order", () => {
    const source = `---
type: task
# keep this comment
custom: value
status: todo
---
body
`;
    const updated = updateFrontmatter(source, { status: "done" });
    assert.strictEqual(
      updated,
      `---
type: task
# keep this comment
custom: value
status: done
---
body
`,
    );
  });

  it("adds and deletes fields", () => {
    const source = "---\ntype: task\nstatus: todo\ndue: 2026-01-01\n---\nbody\n";
    const updated = updateFrontmatter(source, { completed: "2026-02-02", due: undefined });
    assert.strictEqual(
      updated,
      "---\ntype: task\nstatus: todo\ncompleted: 2026-02-02\n---\nbody\n",
    );
  });

  it("creates a frontmatter block when the file has none", () => {
    const updated = updateFrontmatter("# Hello\n", { type: "note", title: "Hello" });
    assert.strictEqual(updated, "---\ntype: note\ntitle: Hello\n---\n# Hello\n");
  });

  it("preserves CRLF style when updating", () => {
    const source = "---\r\ntype: task\r\nstatus: todo\r\n---\r\nbody\r\n";
    const updated = updateFrontmatter(source, { status: "doing" });
    assert.strictEqual(updated, "---\r\ntype: task\r\nstatus: doing\r\n---\r\nbody\r\n");
  });

  it("fills an empty frontmatter block", () => {
    const updated = updateFrontmatter("---\n---\nbody\n", { type: "note" });
    assert.strictEqual(updated, "---\ntype: note\n---\nbody\n");
  });

  it("throws on invalid YAML rather than corrupting the file", () => {
    assert.throws(() => updateFrontmatter("---\ntitle: [unclosed\n---\nbody\n", { title: "x" }));
  });
});
