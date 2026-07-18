/**
 * Voice-layer interfaces.
 *
 * Deliberately small: the current half-duplex loop (on-device STT -> agent ->
 * on-device TTS) hides behind these two interfaces so a future realtime
 * full-duplex engine can swap in without touching the composer or thread
 * screens.
 */

export type DictationEvent =
  | { readonly type: "started" }
  | { readonly type: "transcript"; readonly transcript: string; readonly isFinal: boolean }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "ended" };

export interface DictationEngine {
  /** Whether speech recognition is available on this device/build. */
  isAvailable(): boolean;
  /** Prompt for microphone + speech-recognition permission. Resolves false when denied. */
  requestPermissions(): Promise<boolean>;
  /**
   * Begin a recognition session. Events arrive on registered listeners until
   * an "ended" event closes the session.
   */
  start(options?: { readonly lang?: string }): void;
  /** Stop capturing and let the engine deliver its final transcript. */
  stop(): void;
  /** Cancel immediately, discarding any pending result. */
  abort(): void;
  /** Subscribe to session events. Returns an unsubscribe function. */
  addListener(listener: (event: DictationEvent) => void): () => void;
}

export interface ReplySpeaker {
  /** Speak `text`, cutting off any utterance already in progress. */
  speak(text: string): void;
  stop(): void;
}
