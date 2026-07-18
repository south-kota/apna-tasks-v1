import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";

import type { OrchestrationThread } from "@t3tools/contracts";

import { mobilePreferencesAtom } from "../state/preferences";
import { createExpoReplySpeaker } from "./expoReplySpeaker";
import { detectTurnSettled, selectAssistantReplyText, type TurnSnapshot } from "./replyCompletion";
import { trimReplyForSpeech } from "./replySpeech";
import type { ReplySpeaker } from "./types";
import { consumeVoiceInitiatedSend } from "./voiceTurnRegistry";

/**
 * Speaks the agent's reply when a voice-initiated turn completes and the
 * global "Voice Replies" preference is on. Mount once per selected thread.
 */
export function useSpeakAgentReplies(input: {
  readonly thread: OrchestrationThread | null;
  readonly threadKey: string | null;
  /** Injectable for tests; defaults to the expo-speech speaker. */
  readonly speaker?: ReplySpeaker;
}): void {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const voiceRepliesEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.voiceRepliesEnabled === true
    : false;

  const externalSpeaker = input.speaker ?? null;
  const speaker = useMemo(() => externalSpeaker ?? createExpoReplySpeaker(), [externalSpeaker]);

  const previousTurnRef = useRef<TurnSnapshot | null>(null);
  const pendingTurnIdRef = useRef<string | null>(null);
  const trackedThreadKeyRef = useRef<string | null>(null);

  const { thread, threadKey } = input;

  useEffect(() => {
    if (trackedThreadKeyRef.current !== threadKey) {
      trackedThreadKeyRef.current = threadKey;
      previousTurnRef.current = null;
      pendingTurnIdRef.current = null;
    }

    const currentTurn: TurnSnapshot | null = thread?.latestTurn
      ? { turnId: thread.latestTurn.turnId, state: thread.latestTurn.state }
      : null;
    const previousTurn = previousTurnRef.current;
    previousTurnRef.current = currentTurn;

    if (thread === null || threadKey === null) return;

    const settled = detectTurnSettled(previousTurn, currentTurn);
    if (settled !== null) {
      // Consume the mark on every settled turn so a stale mark from an
      // interrupted or errored turn cannot voice a later, unrelated reply.
      const wasVoiceInitiated = consumeVoiceInitiatedSend(threadKey);
      if (wasVoiceInitiated && settled.outcome === "completed" && voiceRepliesEnabled) {
        pendingTurnIdRef.current = settled.turnId;
      }
    }

    // The assistant message may still be streaming when the turn settles;
    // retry on each thread update until the text is final.
    const pendingTurnId = pendingTurnIdRef.current;
    if (pendingTurnId !== null) {
      const replyText = selectAssistantReplyText(thread, pendingTurnId);
      if (thread.latestTurn?.turnId !== pendingTurnId) {
        pendingTurnIdRef.current = null;
      } else if (replyText !== null) {
        pendingTurnIdRef.current = null;
        const speech = trimReplyForSpeech(replyText);
        if (speech.length > 0) {
          speaker.speak(speech);
        }
      }
    }
  }, [speaker, thread, threadKey, voiceRepliesEnabled]);

  // Stop speaking when the screen unmounts or the thread changes.
  useEffect(() => {
    return () => {
      speaker.stop();
    };
  }, [speaker, threadKey]);
}
