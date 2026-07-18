/**
 * Tracks which threads had their most recent send initiated by voice
 * dictation, so the reply for that turn can be spoken back.
 *
 * Module-level on purpose: the composer (marks) and the thread screen
 * (consumes) live in different component trees.
 */

const voiceInitiatedThreadKeys = new Set<string>();

export function markVoiceInitiatedSend(threadKey: string): void {
  voiceInitiatedThreadKeys.add(threadKey);
}

/** Returns whether the thread's pending turn was voice-initiated, clearing the mark. */
export function consumeVoiceInitiatedSend(threadKey: string): boolean {
  const wasVoiceInitiated = voiceInitiatedThreadKeys.has(threadKey);
  voiceInitiatedThreadKeys.delete(threadKey);
  return wasVoiceInitiated;
}

export function resetVoiceTurnRegistry(): void {
  voiceInitiatedThreadKeys.clear();
}
