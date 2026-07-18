import { assert, describe, it } from "@effect/vitest";

import { scanBody } from "./Markdown.ts";

describe("Markdown.scanBody", () => {
  it("finds the first H1 for title fallback", () => {
    const scan = scanBody("intro\n\n# The Title\n\n# Second\n");
    assert.strictEqual(scan.firstHeading, "The Title");
  });

  it("extracts markdown links, wiki links, and embeds", () => {
    const scan = scanBody(
      [
        "See [Auth notes](../notes/auth.md) and [[sync-model]].",
        "Alias link: [[sync-model|the sync doc]].",
        "Embed: ![diagram](assets/diagram.png)",
        "External: [site](https://example.com/page)",
      ].join("\n"),
    );
    assert.deepStrictEqual(
      scan.links.map((link) => [link.kind, link.rawTarget]),
      [
        // wiki links are reported before markdown links within a line
        ["wiki", "sync-model"],
        ["markdown", "../notes/auth.md"],
        ["wiki", "sync-model"],
        ["embed", "assets/diagram.png"],
        ["markdown", "https://example.com/page"],
      ],
    );
    assert.strictEqual(scan.links[2]?.text, "the sync doc");
  });

  it("strips heading anchors from wiki targets", () => {
    const scan = scanBody("[[sync-model#Conflict rules]]\n");
    assert.strictEqual(scan.links[0]?.rawTarget, "sync-model");
  });

  it("collects inline tags but not headings or pure numbers", () => {
    const scan = scanBody("Work on #jbom and #sync/files today\n\n# Heading\n\nIssue #42\n");
    assert.deepStrictEqual([...scan.tags].sort(), ["jbom", "sync/files"]);
  });

  it("ignores tags and links inside code fences and inline code", () => {
    const scan = scanBody(
      [
        "```",
        "#not-a-tag [not](a-link.md)",
        "```",
        "Real #tag here",
        "and `#inline-code` too",
      ].join("\n"),
    );
    assert.deepStrictEqual(scan.tags, ["tag"]);
    assert.strictEqual(scan.links.length, 0);
  });

  it("parses task-reference lines with sequence and status tokens", () => {
    const scan = scanBody(
      [
        "- [ ] 01-02 doing [Redesign reset flow](tasks/I-01-02-redesign-reset-flow.md)",
        "- [x] 01-01 done [Audit auth paths](tasks/O-01-01-audit-auth-paths.md)",
        "  - [ ] [[child-task]]",
        "- [ ] plain checklist item, no link",
      ].join("\n"),
    );
    assert.strictEqual(scan.taskReferences.length, 4);
    const [first, second, third, fourth] = scan.taskReferences;
    assert.deepStrictEqual(
      { checked: first?.checked, sequence: first?.sequence, statusToken: first?.statusToken },
      { checked: false, sequence: "01-02", statusToken: "doing" },
    );
    assert.strictEqual(first?.link?.rawTarget, "tasks/I-01-02-redesign-reset-flow.md");
    assert.strictEqual(second?.checked, true);
    assert.strictEqual(third?.indent, 2);
    assert.strictEqual(third?.link?.rawTarget, "child-task");
    assert.isUndefined(fourth?.link);
  });

  it("reports line numbers with the given offset", () => {
    const scan = scanBody("first\n[link](x.md)\n", 5);
    assert.strictEqual(scan.links[0]?.line, 7);
  });
});
