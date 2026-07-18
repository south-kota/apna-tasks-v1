import * as Speech from "expo-speech";

import type { ReplySpeaker } from "./types";

/**
 * ReplySpeaker backed by expo-speech (AVSpeechSynthesizer on iOS). On-device,
 * no network, starts speaking near-instantly.
 */
export function createExpoReplySpeaker(): ReplySpeaker {
  return {
    speak: (text) => {
      const capped =
        text.length > Speech.maxSpeechInputLength
          ? text.slice(0, Speech.maxSpeechInputLength - 1)
          : text;
      if (capped.length === 0) return;
      // Cut off any utterance already in progress; the newest reply wins.
      void Speech.stop();
      Speech.speak(capped);
    },
    stop: () => {
      void Speech.stop();
    },
  };
}
