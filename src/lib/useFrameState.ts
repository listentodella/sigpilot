import { useCallback, useSyncExternalStore } from "react";
import type { FrameLoopState } from "./frameLoop.ts";
import { readFrameState, subscribeFrameState } from "./frameStore.ts";

/**
 * Subscribes a component to the backend-driven frame pipeline for a session.
 *
 * Returns `null` until the workbench has wired the session up, so a caller can
 * fall back to its own rendering path. Once it returns a state, the component is
 * receiving viewport and data straight from the backend and must not clamp or
 * second-guess either.
 */
export function useSessionFrameState(sessionId: string | undefined): FrameLoopState | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!sessionId) return () => {};
      return subscribeFrameState(sessionId, onStoreChange);
    },
    [sessionId],
  );
  // Must be a stable reference: the store only replaces the object on a real
  // frame, and returns null while the session is not wired up.
  const getSnapshot = useCallback(
    () => (sessionId ? readFrameState(sessionId) : null),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
