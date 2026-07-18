import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  composeDictatedDraft,
  idleDictationSession,
  reduceDictationSession,
  type DictationSessionEvent,
  type DictationSessionState,
} from "./dictationSession";
import { createExpoDictationEngine } from "./expoDictationEngine";
import type { DictationEngine } from "./types";

export interface VoiceDictationHandle {
  readonly status: DictationSessionState["status"];
  /** True from the moment dictation is requested until the session ends. */
  readonly isDictating: boolean;
  readonly error: string | null;
  /** Tap: toggle dictation. */
  readonly toggle: () => void;
  /** Hold-to-talk: start on long press, stop on release. */
  readonly onLongPress: () => void;
  readonly onPressOut: () => void;
  /** Cancel immediately (e.g. when the message is sent mid-dictation). */
  readonly abort: () => void;
  /**
   * Whether dictation contributed text to the draft since the last call.
   * Consumed by the send path to mark the turn as voice-initiated.
   */
  readonly consumeDictationContribution: () => boolean;
}

/**
 * Push-to-talk dictation for the thread composer. Partial transcripts stream
 * into the draft (via `onChangeDraftText`) so the user can glance and edit
 * before sending through the normal send path.
 */
export function useVoiceDictation(input: {
  readonly draftText: string;
  readonly onChangeDraftText: (value: string) => void;
  /** Injectable for tests; defaults to the expo-speech-recognition engine. */
  readonly engine?: DictationEngine;
}): VoiceDictationHandle {
  const externalEngine = input.engine ?? null;
  const engine = useMemo(() => externalEngine ?? createExpoDictationEngine(), [externalEngine]);

  const [state, setState] = useState(idleDictationSession);
  const stateRef = useRef(state);
  const draftRef = useRef(input.draftText);
  draftRef.current = input.draftText;
  const onChangeDraftTextRef = useRef(input.onChangeDraftText);
  onChangeDraftTextRef.current = input.onChangeDraftText;
  const contributedRef = useRef(false);
  const heldRef = useRef(false);

  const dispatch = useCallback((event: DictationSessionEvent) => {
    const next = reduceDictationSession(stateRef.current, event);
    stateRef.current = next;
    setState(next);
    if (
      event.type === "transcript" &&
      event.transcript.length > 0 &&
      (next.status === "listening" || next.status === "stopping")
    ) {
      contributedRef.current = true;
      onChangeDraftTextRef.current(composeDictatedDraft(next.baseText, event.transcript));
    }
  }, []);

  useEffect(() => {
    const removeListener = engine.addListener((event) => {
      switch (event.type) {
        case "started":
          dispatch({ type: "engine-started" });
          break;
        case "transcript":
          dispatch({ type: "transcript", transcript: event.transcript, isFinal: event.isFinal });
          break;
        case "error":
          // "aborted" arrives after an intentional abort; not a user-facing error.
          dispatch(
            event.code === "aborted"
              ? { type: "aborted" }
              : { type: "engine-error", message: event.message },
          );
          break;
        case "ended":
          dispatch({ type: "engine-ended" });
          break;
      }
    });
    return removeListener;
  }, [dispatch, engine]);

  const abort = useCallback(() => {
    if (stateRef.current.status === "idle") return;
    dispatch({ type: "aborted" });
    engine.abort();
  }, [dispatch, engine]);

  // Cancel any in-flight session when the composer unmounts (thread switch).
  useEffect(() => {
    return () => {
      if (stateRef.current.status !== "idle") {
        engine.abort();
      }
    };
  }, [engine]);

  const start = useCallback(async () => {
    if (stateRef.current.status !== "idle") return;
    dispatch({ type: "requested", baseText: draftRef.current });
    const granted = await engine.requestPermissions();
    // Re-read: dispatch and engine events mutate the ref outside TS's view.
    const statusAfterPermission = (stateRef.current as DictationSessionState).status;
    if (statusAfterPermission !== "starting") {
      // Aborted (or otherwise moved on) while the permission prompt was up.
      return;
    }
    if (!granted) {
      dispatch({
        type: "engine-error",
        message: "Microphone or speech recognition permission was denied.",
      });
      return;
    }
    engine.start();
  }, [dispatch, engine]);

  const stop = useCallback(() => {
    const status = stateRef.current.status;
    if (status !== "starting" && status !== "listening") return;
    dispatch({ type: "stop-requested" });
    engine.stop();
  }, [dispatch, engine]);

  const toggle = useCallback(() => {
    if (stateRef.current.status === "idle") {
      void start();
    } else {
      stop();
    }
  }, [start, stop]);

  const onLongPress = useCallback(() => {
    if (stateRef.current.status !== "idle") return;
    heldRef.current = true;
    void start();
  }, [start]);

  const onPressOut = useCallback(() => {
    if (!heldRef.current) return;
    heldRef.current = false;
    stop();
  }, [stop]);

  const consumeDictationContribution = useCallback(() => {
    const contributed = contributedRef.current;
    contributedRef.current = false;
    return contributed;
  }, []);

  return {
    status: state.status,
    isDictating: state.status !== "idle",
    error: state.error,
    toggle,
    onLongPress,
    onPressOut,
    abort,
    consumeDictationContribution,
  };
}
