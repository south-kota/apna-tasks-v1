import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  consumeVoiceInitiatedSend,
  markVoiceInitiatedSend,
  resetVoiceTurnRegistry,
} from "./voiceTurnRegistry";

describe("voiceTurnRegistry", () => {
  beforeEach(() => {
    resetVoiceTurnRegistry();
  });

  it("consumes a mark exactly once", () => {
    markVoiceInitiatedSend("env-1:thread-1");
    expect(consumeVoiceInitiatedSend("env-1:thread-1")).toBe(true);
    expect(consumeVoiceInitiatedSend("env-1:thread-1")).toBe(false);
  });

  it("scopes marks per thread", () => {
    markVoiceInitiatedSend("env-1:thread-1");
    expect(consumeVoiceInitiatedSend("env-1:thread-2")).toBe(false);
    expect(consumeVoiceInitiatedSend("env-1:thread-1")).toBe(true);
  });

  it("returns false when nothing was marked", () => {
    expect(consumeVoiceInitiatedSend("env-1:thread-1")).toBe(false);
  });
});
