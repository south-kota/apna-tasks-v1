/**
 * Pure state machine for a push-to-talk dictation session.
 *
 * The engine (native speech recognizer) reports cumulative transcripts for the
 * whole session, so the machine keeps the draft text captured at session start
 * (`baseText`) and the latest cumulative `transcript` separately; the composed
 * draft is always `baseText + transcript`.
 */

export type DictationStatus = "idle" | "starting" | "listening" | "stopping";

export interface DictationSessionState {
  readonly status: DictationStatus;
  /** Draft text captured when the session started; dictation appends after it. */
  readonly baseText: string;
  /** Cumulative transcript for the current recognition session. */
  readonly transcript: string;
  /** Last session error, surfaced until the next session starts. */
  readonly error: string | null;
}

export const idleDictationSession: DictationSessionState = {
  status: "idle",
  baseText: "",
  transcript: "",
  error: null,
};

export type DictationSessionEvent =
  | { readonly type: "requested"; readonly baseText: string }
  | { readonly type: "engine-started" }
  | { readonly type: "transcript"; readonly transcript: string; readonly isFinal: boolean }
  | { readonly type: "stop-requested" }
  | { readonly type: "engine-error"; readonly message: string }
  | { readonly type: "engine-ended" }
  | { readonly type: "aborted" };

export function reduceDictationSession(
  state: DictationSessionState,
  event: DictationSessionEvent,
): DictationSessionState {
  switch (event.type) {
    case "requested":
      if (state.status !== "idle") return state;
      return { status: "starting", baseText: event.baseText, transcript: "", error: null };
    case "engine-started":
      if (state.status !== "starting") return state;
      return { ...state, status: "listening" };
    case "transcript":
      if (state.status !== "listening" && state.status !== "stopping") return state;
      return { ...state, transcript: event.transcript };
    case "stop-requested":
      if (state.status !== "starting" && state.status !== "listening") return state;
      return { ...state, status: "stopping" };
    case "engine-error":
      if (state.status === "idle") return state;
      // Keep the transcript: partial text already applied to the draft stays.
      return { ...state, status: "idle", error: event.message };
    case "engine-ended":
      if (state.status === "idle") return state;
      return { ...state, status: "idle" };
    case "aborted":
      if (state.status === "idle") return state;
      return { ...state, status: "idle", transcript: "" };
  }
}

/**
 * Compose the draft text shown while dictating: the pre-dictation draft plus
 * the cumulative transcript, joined with a single separating space when
 * needed.
 */
export function composeDictatedDraft(baseText: string, transcript: string): string {
  if (transcript.length === 0) return baseText;
  if (baseText.length === 0) return transcript;
  if (/\s$/.test(baseText)) return `${baseText}${transcript}`;
  return `${baseText} ${transcript}`;
}
