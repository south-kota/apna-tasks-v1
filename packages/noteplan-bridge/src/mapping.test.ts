import { assert, describe, it } from "@effect/vitest";
import { notePlanToVault, vaultToNotePlan } from "./mapping.ts";

const vaultDaily = [
  "---",
  "type: daily",
  "date: 2026-07-18",
  "---",
  "# Friday",
  "",
  "- [ ] water the plants 📅 2026-07-18",
  "- [ ] book flights 📅 2026-08-02",
  "- [x] morning pages ✅ 2026-07-18",
  "- plain bullet stays a bullet",
  "prose stays prose",
  "",
].join("\n");

const notePlanDaily = [
  "# Friday",
  "",
  "- [ ] water the plants",
  "- [ ] book flights >2026-08-02",
  "- [x] morning pages @done(2026-07-18)",
  "- plain bullet stays a bullet",
  "prose stays prose",
  "",
].join("\n");

describe("daily note mapping", () => {
  it("vault -> NotePlan strips frontmatter, drops same-day due dates, schedules others", () => {
    assert.strictEqual(vaultToNotePlan(vaultDaily, "2026-07-18"), notePlanDaily);
  });

  it("NotePlan -> vault preserves the previous frontmatter verbatim", () => {
    const result = notePlanToVault(notePlanDaily, {
      noteDate: "2026-07-18",
      previousVaultContent: vaultDaily,
    });
    assert.isTrue(result.startsWith("---\ntype: daily\ndate: 2026-07-18\n---\n"));
    assert.include(result, "- [ ] book flights 📅 2026-08-02");
    assert.include(result, "- [x] morning pages ✅ 2026-07-18");
    assert.include(result, "- plain bullet stays a bullet");
  });

  it("NotePlan -> vault generates minimal frontmatter for brand-new dailies", () => {
    const result = notePlanToVault("- [ ] imported task\n", {
      noteDate: "2026-07-18",
      previousVaultContent: null,
    });
    assert.isTrue(result.startsWith("---\n"));
    assert.include(result, "date: 2026-07-18");
    assert.include(result, "- [ ] imported task");
  });

  it("is stable under repeated round trips (no ping-pong)", () => {
    const np1 = vaultToNotePlan(vaultDaily, "2026-07-18");
    const vault1 = notePlanToVault(np1, {
      noteDate: "2026-07-18",
      previousVaultContent: vaultDaily,
    });
    const np2 = vaultToNotePlan(vault1, "2026-07-18");
    const vault2 = notePlanToVault(np2, { noteDate: "2026-07-18", previousVaultContent: vault1 });
    assert.strictEqual(np2, np1);
    assert.strictEqual(vault2, vault1);
  });

  it("completion state maps both ways", () => {
    const completedInNotePlan = notePlanDaily.replace(
      "- [ ] water the plants",
      "- [x] water the plants",
    );
    const vaultResult = notePlanToVault(completedInNotePlan, {
      noteDate: "2026-07-18",
      previousVaultContent: vaultDaily,
    });
    assert.include(vaultResult, "- [x] water the plants");

    const completedInVault = vaultDaily.replace("- [ ] book flights", "- [x] book flights");
    assert.include(
      vaultToNotePlan(completedInVault, "2026-07-18"),
      "- [x] book flights >2026-08-02",
    );
  });
});

describe("project note mapping", () => {
  it("keeps every due date as a schedule token so tasks appear on the calendar", () => {
    const vaultNote = "---\ntitle: Errands\n---\n- [ ] renew passport 📅 2026-09-01\n";
    assert.strictEqual(vaultToNotePlan(vaultNote, null), "- [ ] renew passport >2026-09-01\n");
  });

  it("Kota-style bare checkboxes round-trip untouched", () => {
    const notePlanNote = "## list\n- [ ] simple open\n- [x] simple done\n- untouched bullet\n";
    const vaultResult = notePlanToVault(notePlanNote, {
      noteDate: null,
      previousVaultContent: null,
    });
    assert.strictEqual(vaultResult, notePlanNote);
    assert.strictEqual(vaultToNotePlan(vaultResult, null), notePlanNote);
  });
});
