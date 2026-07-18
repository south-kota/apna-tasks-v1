import { describe, expect, it } from "vite-plus/test";

import { trimReplyForSpeech } from "./replySpeech";

describe("trimReplyForSpeech", () => {
  it("passes plain prose through", () => {
    expect(trimReplyForSpeech("Done. I updated the login flow.")).toBe(
      "Done. I updated the login flow.",
    );
  });

  it("strips fenced code blocks entirely", () => {
    const markdown = [
      "I fixed it like this:",
      "```ts",
      "const x = 1;",
      "console.log(x);",
      "```",
      "Let me know if that works.",
    ].join("\n");
    const result = trimReplyForSpeech(markdown);
    expect(result).not.toContain("const x");
    expect(result).toContain("I fixed it like this:");
    expect(result).toContain("Let me know if that works.");
  });

  it("drops an unterminated code fence to the end", () => {
    const markdown = "Summary first.\n```\nunterminated code";
    const result = trimReplyForSpeech(markdown);
    expect(result).toBe("Summary first.");
  });

  it("keeps inline code content without backticks", () => {
    expect(trimReplyForSpeech("Run `npm install` first.")).toBe("Run npm install first.");
  });

  it("reduces links and images to their text", () => {
    expect(trimReplyForSpeech("See [the docs](https://example.com) and ![diagram](img.png)")).toBe(
      "See the docs and diagram",
    );
  });

  it("replaces bare urls with 'link'", () => {
    expect(trimReplyForSpeech("Deployed to https://example.com/app now.")).toBe(
      "Deployed to link now.",
    );
  });

  it("strips heading, list, and emphasis markup", () => {
    const markdown = ["## Plan", "- **First** step", "- Second step", "> note"].join("\n");
    const result = trimReplyForSpeech(markdown);
    expect(result).not.toContain("#");
    expect(result).not.toContain("**");
    expect(result).not.toContain("- ");
    expect(result).toContain("Plan");
    expect(result).toContain("First step");
    expect(result).toContain("note");
  });

  it("drops tables and horizontal rules", () => {
    const markdown = ["Before.", "| a | b |", "| --- | --- |", "| 1 | 2 |", "---", "After."].join(
      "\n",
    );
    const result = trimReplyForSpeech(markdown);
    expect(result).not.toContain("|");
    expect(result).toContain("Before.");
    expect(result).toContain("After.");
  });

  it("keeps snake_case identifiers intact", () => {
    expect(trimReplyForSpeech("Renamed to `user_profile_id`.")).toBe("Renamed to user_profile_id.");
  });

  it("caps long replies at a sentence boundary", () => {
    const sentence = "This sentence is fairly long and repeated many times. ";
    const result = trimReplyForSpeech(sentence.repeat(50), { maxLength: 200 });
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith(".")).toBe(true);
  });

  it("falls back to a word boundary when no sentence end exists", () => {
    const words = "word ".repeat(100);
    const result = trimReplyForSpeech(words, { maxLength: 50 });
    expect(result.length).toBeLessThanOrEqual(51);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns empty for a reply that is only code", () => {
    expect(trimReplyForSpeech("```js\n1\n```")).toBe("");
  });
});
