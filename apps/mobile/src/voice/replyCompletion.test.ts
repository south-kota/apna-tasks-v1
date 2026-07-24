import { describe, expect, it } from "vite-plus/test";

import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { detectTurnSettled, selectAssistantReplyText } from "./replyCompletion";

function makeMessage(
  input: Partial<OrchestrationMessage> & Pick<OrchestrationMessage, "id" | "role" | "text">,
): OrchestrationMessage {
  return {
    turnId: null,
    streaming: false,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(input: Partial<OrchestrationThread>): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Voice thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...input,
  };
}

describe("detectTurnSettled", () => {
  it("fires when a running turn completes", () => {
    expect(
      detectTurnSettled(
        { turnId: "turn-1", state: "running" },
        { turnId: "turn-1", state: "completed" },
      ),
    ).toEqual({ turnId: "turn-1", outcome: "completed" });
  });

  it("reports error and interrupted outcomes", () => {
    expect(
      detectTurnSettled(
        { turnId: "turn-1", state: "running" },
        { turnId: "turn-1", state: "error" },
      ),
    ).toEqual({ turnId: "turn-1", outcome: "error" });
    expect(
      detectTurnSettled(
        { turnId: "turn-1", state: "running" },
        { turnId: "turn-1", state: "interrupted" },
      ),
    ).toEqual({ turnId: "turn-1", outcome: "interrupted" });
  });

  it("stays quiet while running or when nothing changed", () => {
    expect(
      detectTurnSettled(
        { turnId: "turn-1", state: "running" },
        { turnId: "turn-1", state: "running" },
      ),
    ).toBeNull();
    expect(
      detectTurnSettled(
        { turnId: "turn-1", state: "completed" },
        { turnId: "turn-1", state: "completed" },
      ),
    ).toBeNull();
  });

  it("ignores turns that were already settled at mount", () => {
    expect(detectTurnSettled(null, { turnId: "turn-1", state: "completed" })).toBeNull();
  });

  it("ignores transitions across different turns", () => {
    expect(
      detectTurnSettled(
        { turnId: "turn-1", state: "running" },
        { turnId: "turn-2", state: "completed" },
      ),
    ).toBeNull();
  });

  it("handles a missing current turn", () => {
    expect(detectTurnSettled({ turnId: "turn-1", state: "running" }, null)).toBeNull();
  });
});

describe("selectAssistantReplyText", () => {
  const assistantMessageId = MessageId.make("message-2");
  const turn = {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-04-01T00:00:00.000Z",
    startedAt: "2026-04-01T00:00:01.000Z",
    completedAt: "2026-04-01T00:00:09.000Z",
    assistantMessageId,
  };

  it("returns the settled assistant reply text", () => {
    const thread = makeThread({
      latestTurn: turn,
      messages: [
        makeMessage({ id: MessageId.make("message-1"), role: "user", text: "do the thing" }),
        makeMessage({ id: assistantMessageId, role: "assistant", text: "Done, all tests pass." }),
      ],
    });
    expect(selectAssistantReplyText(thread, "turn-1")).toBe("Done, all tests pass.");
  });

  it("returns null while the reply is still streaming", () => {
    const thread = makeThread({
      latestTurn: turn,
      messages: [
        makeMessage({
          id: assistantMessageId,
          role: "assistant",
          text: "Partial...",
          streaming: true,
        }),
      ],
    });
    expect(selectAssistantReplyText(thread, "turn-1")).toBeNull();
  });

  it("returns null when the turn has no assistant message or does not match", () => {
    const withoutMessage = makeThread({
      latestTurn: { ...turn, assistantMessageId: null },
    });
    expect(selectAssistantReplyText(withoutMessage, "turn-1")).toBeNull();
    const otherTurn = makeThread({ latestTurn: turn });
    expect(selectAssistantReplyText(otherTurn, "turn-9")).toBeNull();
    expect(selectAssistantReplyText(makeThread({}), "turn-1")).toBeNull();
  });
});
