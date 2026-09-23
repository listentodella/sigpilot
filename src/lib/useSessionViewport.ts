import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  readSessionViewport,
  subscribeSessionViewport,
  type SessionViewport,
} from "./viewportStore.ts";

// Overlays that have to track a pan or zoom frame by frame used to depend on the
// workbench re-rendering, which meant every wheel tick reconciled the whole
// application. Subscribing here re-renders only the overlay, so the workbench
// can be told about the viewport at whatever cadence it can actually act on.
//
// `fallbackStart`/`fallbackSamples` are the settled viewport the parent passes
// down. They are only used before the first store write for the session.
export function useSessionViewport(
  sessionId: string | undefined,
  fallbackStart: number,
  fallbackSamples: number,
): SessionViewport {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!sessionId) return () => {};
      return subscribeSessionViewport(sessionId, onStoreChange);
    },
    [sessionId],
  );
  // Must return a stable reference: the store only replaces the object on a real
  // change, and returns null when the session has no entry yet.
  const getSnapshot = useCallback(
    () => (sessionId ? readSessionViewport(sessionId) : null),
    [sessionId],
  );
  const live = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const fallbackRef = useRef<SessionViewport>({ samples: fallbackSamples, start: fallbackStart });
  if (
    fallbackRef.current.start !== fallbackStart ||
    fallbackRef.current.samples !== fallbackSamples
  ) {
    fallbackRef.current = { samples: fallbackSamples, start: fallbackStart };
  }

  return live ?? fallbackRef.current;
}
