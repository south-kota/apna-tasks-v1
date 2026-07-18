import { describe, expect, it } from "vite-plus/test";

import {
  composeDictatedDraft,
  idleDictationSession,
  reduceDictationSession,
  type DictationSessionEvent,
  type DictationSessionState,
} from "./dictationSession";

function run(events: ReadonlyArray<DictationSessionEvent>): DictationSessionState {
  return events.reduce(reduceDictationSession, idleDictationSession);
}

describe("reduceDictationSession", () => {
  it("walks the happy path: request -> listening -> transcripts -> stop -> ended", () => {
    let state = run([{ type: "requested", baseText: "existing draft" }]);
    expect(state.status).toBe("starting");
    expect(state.baseText).toBe("existing draft");

    state = reduceDictationSession(state, { type: "engine-started" });
    expect(state.status).toBe("listening");

    state = reduceDictationSession(state, {
      type: "transcript",
      transcript: "hello",
      isFinal: false,
    });
    state = reduceDictationSession(state, {
      type: "transcript",
      transcript: "hello world",
      isFinal: false,
    });
    expect(state.transcript).toBe("hello world");

    state = reduceDictationSession(state, { type: "stop-requested" });
    expect(state.status).toBe("stopping");

    // Final transcript still lands while stopping.
    state = reduceDictationSession(state, {
      type: "transcript",
      transcript: "hello world!",
      isFinal: true,
    });
    expect(state.transcript).toBe("hello world!");

    state = reduceDictationSession(state, { type: "engine-ended" });
    expect(state.status).toBe("idle");
  });

  it("ignores a start request while a session is active", () => {
    const listening = run([{ type: "requested", baseText: "a" }, { type: "engine-started" }]);
    const next = reduceDictationSession(listening, { type: "requested", baseText: "b" });
    expect(next).toBe(listening);
  });

  it("ignores transcripts before the engine has started", () => {
    const starting = run([{ type: "requested", baseText: "" }]);
    const next = reduceDictationSession(starting, {
      type: "transcript",
      transcript: "ghost",
      isFinal: false,
    });
    expect(next.transcript).toBe("");
  });

  it("returns to idle with the error surfaced on engine errors", () => {
    const state = run([
      { type: "requested", baseText: "" },
      { type: "engine-started" },
      { type: "transcript", transcript: "partial words", isFinal: false },
      { type: "engine-error", message: "no speech detected" },
    ]);
    expect(state.status).toBe("idle");
    expect(state.error).toBe("no speech detected");
    // Partial transcript already applied to the draft is retained.
    expect(state.transcript).toBe("partial words");
  });

  it("clears the error when a new session starts", () => {
    const state = run([
      { type: "requested", baseText: "" },
      { type: "engine-error", message: "boom" },
      { type: "requested", baseText: "" },
    ]);
    expect(state.error).toBeNull();
    expect(state.status).toBe("starting");
  });

  it("discards the transcript on abort", () => {
    const state = run([
      { type: "requested", baseText: "" },
      { type: "engine-started" },
      { type: "transcript", transcript: "cancel me", isFinal: false },
      { type: "aborted" },
    ]);
    expect(state.status).toBe("idle");
    expect(state.transcript).toBe("");
  });
});

describe("composeDictatedDraft", () => {
  it("returns the base text when nothing was transcribed", () => {
    expect(composeDictatedDraft("draft", "")).toBe("draft");
  });

  it("returns the transcript alone for an empty draft", () => {
    expect(composeDictatedDraft("", "hello there")).toBe("hello there");
  });

  it("joins base and transcript with a single space", () => {
    expect(composeDictatedDraft("Fix the bug", "in the login flow")).toBe(
      "Fix the bug in the login flow",
    );
  });

  it("does not double up separators when the base ends with whitespace", () => {
    expect(composeDictatedDraft("Fix the bug\n", "quickly")).toBe("Fix the bug\nquickly");
    expect(composeDictatedDraft("Fix the bug ", "quickly")).toBe("Fix the bug quickly");
  });
});
