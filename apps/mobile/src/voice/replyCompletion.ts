import type { OrchestrationLatestTurnState, OrchestrationThread } from "@t3tools/contracts";

/**
 * Pure helpers for deciding when an agent turn has settled and which reply
 * text should be spoken. Kept free of React so they unit-test directly.
 */

export interface TurnSnapshot {
  readonly turnId: string;
  readonly state: OrchestrationLatestTurnState;
}

export interface SettledTurn {
  readonly turnId: string;
  readonly outcome: Exclude<OrchestrationLatestTurnState, "running">;
}

/**
 * Detects the moment a turn transitions out of "running". Returns null while
 * the turn is still running, when nothing changed, or when the screen mounted
 * after the turn had already settled (no transition observed).
 */
export function detectTurnSettled(
  previous: TurnSnapshot | null,
  current: TurnSnapshot | null,
): SettledTurn | null {
  if (current === null || current.state === "running") return null;
  if (previous === null || previous.turnId !== current.turnId) return null;
  if (previous.state !== "running") return null;
  return { turnId: current.turnId, outcome: current.state };
}

/**
 * The assistant reply markdown for the thread's latest turn, or null while the
 * message is still streaming (or missing). Callers should retry on the next
 * thread update until this settles.
 */
export function selectAssistantReplyText(
  thread: OrchestrationThread,
  turnId: string,
): string | null {
  const latestTurn = thread.latestTurn;
  if (latestTurn === null || latestTurn.turnId !== turnId) return null;
  if (latestTurn.assistantMessageId === null) return null;
  const message = thread.messages.find((m) => m.id === latestTurn.assistantMessageId);
  if (!message || message.streaming) return null;
  return message.text;
}
