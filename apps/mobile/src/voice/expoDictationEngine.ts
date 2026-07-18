import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

import type { DictationEngine, DictationEvent } from "./types";

/**
 * DictationEngine backed by expo-speech-recognition (SFSpeechRecognizer on
 * iOS, android.speech.SpeechRecognizer on Android).
 *
 * On-device recognition is preferred when the platform supports it (iOS 17+ /
 * Android 13+): it avoids the network round-trip, works offline, and streams
 * partials with lower latency at a small accuracy cost.
 */
export function createExpoDictationEngine(): DictationEngine {
  return {
    isAvailable: () => {
      try {
        return ExpoSpeechRecognitionModule.isRecognitionAvailable();
      } catch {
        return false;
      }
    },
    requestPermissions: async () => {
      try {
        const response = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        return response.granted;
      } catch {
        return false;
      }
    },
    start: (options) => {
      let requiresOnDeviceRecognition = false;
      try {
        requiresOnDeviceRecognition = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
      } catch {
        // Fall back to networked recognition.
      }
      ExpoSpeechRecognitionModule.start({
        lang: options?.lang ?? "en-US",
        interimResults: true,
        // Keep listening until stop() — push-to-talk controls the boundary,
        // not the recognizer's silence detection.
        continuous: true,
        requiresOnDeviceRecognition,
        addsPunctuation: true,
        iosTaskHint: "dictation",
      });
    },
    stop: () => {
      ExpoSpeechRecognitionModule.stop();
    },
    abort: () => {
      ExpoSpeechRecognitionModule.abort();
    },
    addListener: (listener: (event: DictationEvent) => void) => {
      const subscriptions = [
        ExpoSpeechRecognitionModule.addListener("start", () => {
          listener({ type: "started" });
        }),
        ExpoSpeechRecognitionModule.addListener("result", (event) => {
          listener({
            type: "transcript",
            transcript: event.results[0]?.transcript ?? "",
            isFinal: event.isFinal,
          });
        }),
        ExpoSpeechRecognitionModule.addListener("error", (event) => {
          listener({ type: "error", code: event.error, message: event.message });
        }),
        ExpoSpeechRecognitionModule.addListener("end", () => {
          listener({ type: "ended" });
        }),
      ];
      return () => {
        for (const subscription of subscriptions) {
          subscription.remove();
        }
      };
    },
  };
}
