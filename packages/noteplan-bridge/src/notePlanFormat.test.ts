import { assert, describe, it } from "@effect/vitest";
import {
  calendarFileNameFromIsoDate,
  isoDateFromCalendarFileName,
  parseNotePlanTaskLine,
  renderNotePlanTaskLine,
} from "./notePlanFormat.ts";
import { parseVaultTaskLine, renderVaultTaskLine, splitFrontmatter } from "./vaultFormat.ts";

describe("calendar file names", () => {
  it("maps ISO dates to NotePlan daily file names and back", () => {
    assert.strictEqual(calendarFileNameFromIsoDate("2026-07-18"), "20260718.md");
    assert.strictEqual(isoDateFromCalendarFileName("20260718.md"), "2026-07-18");
  });

  it("rejects weekly and monthly calendar files (unmapped)", () => {
    assert.isNull(isoDateFromCalendarFileName("2026-W08.md"));
    assert.isNull(isoDateFromCalendarFileName("2026-07.md"));
    assert.isNull(isoDateFromCalendarFileName("notes.md"));
    assert.isNull(calendarFileNameFromIsoDate("not-a-date"));
  });
});

describe("NotePlan task lines", () => {
  it("parses states, schedule tokens, and @done stamps", () => {
    const task = parseNotePlanTaskLine(
      "\t* [x] ship the bridge >2026-07-20 @done(2026-07-18 14:02)",
    );
    assert.isNotNull(task);
    assert.strictEqual(task?.indent, "\t");
    assert.strictEqual(task?.marker, "*");
    assert.strictEqual(task?.state, "done");
    assert.strictEqual(task?.text, "ship the bridge");
    assert.strictEqual(task?.scheduled, "2026-07-20");
    assert.strictEqual(task?.doneStamp, "2026-07-18 14:02");
  });

  it("parses cancelled and forwarded states", () => {
    assert.strictEqual(parseNotePlanTaskLine("- [-] nope")?.state, "cancelled");
    assert.strictEqual(parseNotePlanTaskLine("- [>] later")?.state, "forwarded");
  });

  it("leaves plain bullets and prose alone", () => {
    assert.isNull(parseNotePlanTaskLine("- just a bullet"));
    assert.isNull(parseNotePlanTaskLine("some prose"));
    assert.isNull(parseNotePlanTaskLine("# heading"));
  });

  it("round-trips render(parse(line))", () => {
    const lines = [
      "- [ ] water the plants",
      "- [x] file taxes @done(2026-03-30 09:00)",
      "  - [ ] nested task >2026-08-01",
      "- [-] cancelled thing",
    ];
    for (const line of lines) {
      const task = parseNotePlanTaskLine(line);
      assert.isNotNull(task);
      assert.strictEqual(renderNotePlanTaskLine(task!), line);
    }
  });
});

describe("vault task lines", () => {
  it("parses due and done dates", () => {
    const task = parseVaultTaskLine("- [x] file taxes 📅 2026-04-01 ✅ 2026-03-30");
    assert.isNotNull(task);
    assert.strictEqual(task?.status, "done");
    assert.strictEqual(task?.title, "file taxes");
    assert.strictEqual(task?.due, "2026-04-01");
    assert.strictEqual(task?.doneDate, "2026-03-30");
  });

  it("round-trips render(parse(line))", () => {
    const lines = [
      "- [ ] water the plants 📅 2026-07-18",
      "- [-] cancelled thing",
      "  - [x] nested ✅ 2026-07-01",
    ];
    for (const line of lines) {
      const task = parseVaultTaskLine(line);
      assert.isNotNull(task);
      assert.strictEqual(renderVaultTaskLine(task!), line);
    }
  });
});

describe("frontmatter", () => {
  it("splits and preserves the frontmatter block verbatim", () => {
    const content = "---\ntitle: hello\ntags: [a, b]\n---\nbody line\n";
    const { frontmatter, body } = splitFrontmatter(content);
    assert.strictEqual(frontmatter, "---\ntitle: hello\ntags: [a, b]\n---\n");
    assert.strictEqual(body, "body line\n");
  });

  it("handles documents without frontmatter", () => {
    const { frontmatter, body } = splitFrontmatter("just body\n");
    assert.isNull(frontmatter);
    assert.strictEqual(body, "just body\n");
  });
});
