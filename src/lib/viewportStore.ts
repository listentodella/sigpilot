// The live viewport is interaction state, not document state. Keeping it in
// React means every wheel tick or drag frame reconciles the whole workbench,
// which is what makes panning and zooming feel heavier than the waveform render
// itself. This store is the out-of-band channel: the canvas publishes here
// synchronously while the gesture is in flight, and React is only told about
// viewports at a cadence it can actually act on.

export interface SessionViewport {
  samples: number;
  start: number;
}

export type SessionViewportListener = (viewport: SessionViewport) => void;

interface ViewportEntry {
  listeners: Set<SessionViewportListener>;
  // null until something actually writes. Subscribing must not fabricate a
  // value, otherwise a reader would see {0, 0} instead of its own fallback
  // during the window before the first canvas render.
  value: SessionViewport | null;
}

const entries = new Map<string, ViewportEntry>();

function entryFor(sessionId: string): ViewportEntry {
  const existing = entries.get(sessionId);
  if (existing) return existing;
  const created: ViewportEntry = { listeners: new Set(), value: null };
  entries.set(sessionId, created);
  return created;
}

export function readSessionViewport(sessionId: string): SessionViewport | null {
  return entries.get(sessionId)?.value ?? null;
}

export function writeSessionViewport(sessionId: string, start: number, samples: number) {
  const entry = entryFor(sessionId);
  const current = entry.value;
  if (current && current.start === start && current.samples === samples) return;
  const next = { samples, start };
  entry.value = next;
  for (const listener of entry.listeners) listener(next);
}

export function subscribeSessionViewport(sessionId: string, listener: SessionViewportListener) {
  const entry = entryFor(sessionId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) entries.delete(sessionId);
  };
}

// Only drops the entry when nobody is listening, so a subscriber that outlives
// the canvas (an overlay, a mini map) keeps receiving updates.
export function clearSessionViewport(sessionId: string) {
  const entry = entries.get(sessionId);
  if (!entry || entry.listeners.size > 0) return;
  entries.delete(sessionId);
}
