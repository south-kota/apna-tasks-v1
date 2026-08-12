import { useSyncExternalStore } from "react";

/**
 * Which surface the left sidebar shows: the thread list (upstream default)
 * or the file tree of the selected vault (Apna Tasks addition).
 */
export type SidebarViewMode = "threads" | "vault";

let currentMode: SidebarViewMode = "threads";
const listeners = new Set<() => void>();

export function setSidebarViewMode(mode: SidebarViewMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  for (const listener of listeners) listener();
}

export function toggleSidebarViewMode(): void {
  setSidebarViewMode(currentMode === "vault" ? "threads" : "vault");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readMode(): SidebarViewMode {
  return currentMode;
}

export function useSidebarViewMode(): SidebarViewMode {
  return useSyncExternalStore(subscribe, readMode, readMode);
}
