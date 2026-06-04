// Rolling event buffer for the Rewind / Share Last Minute feature.
//
// While the rewind rolling video buffer is active on a tab, the service worker
// also captures console / network / navigation / interaction events via the
// same machinery the primary recording uses. Those events are routed here
// instead of into the primary's `queueEvent()` flow.
//
// The buffer is keyed by absolute Date.now() timestamps so we can later slice
// out the window that aligns with the captured-video tail. On Share Last
// Minute we extract events whose timestamp falls inside the clip window and
// re-base them to a relativeTime origin at the clip start.
//
// Memory bound: events older than `bufferSeconds + GRACE` are trimmed on every
// push. There is also a hard cap of MAX_EVENTS to defend against a runaway
// page (e.g. a tight console.log loop). Anything beyond the cap is dropped
// from the oldest end. With reasonable buffer-seconds settings the cap should
// never bite.
//
// Network event matching (the 500ms-3.5s wait for the response body that the
// SW already implements) is performed BEFORE we push here — only fully
// finalized network events go in. Don't push half-formed entries.

import type {
  EventType,
  TimelineEvent,
  ConsoleEventData,
  NetworkEventData,
  NavigationEventData,
  InteractionEventData,
} from '@shared/types';

// Small slop so the share extraction doesn't drop events near the edge of the
// captured video window (which is itself approximate due to MediaRecorder
// chunk boundaries).
const GRACE_MS = 5_000;

// Safety stop — if the page is generating events faster than the buffer can
// trim them, drop oldest. Anything more than this and we have a runaway page;
// the user can deal.
const MAX_EVENTS = 5_000;

export type RewindEventData =
  | ConsoleEventData
  | NetworkEventData
  | NavigationEventData
  | InteractionEventData;

interface BufferedEvent {
  type: EventType;
  timestamp: number; // absolute Date.now() at capture
  data: RewindEventData;
}

export interface ExtractedWindow {
  // Events with relativeTime rebased to the clip start. recordingId is left
  // blank — the upload step fills it in once the server-side recording is
  // created.
  events: TimelineEvent[];
  // Absolute timestamp of the clip start (== endsAt - durationMs). Useful for
  // diagnostics / telemetry; not consumed by the upload path.
  startedAt: number;
}

const buffer: BufferedEvent[] = [];

// Push an event into the rolling buffer. Trims oldest entries that fall out
// of the bufferSeconds + GRACE window (computed against the current Date.now)
// and enforces the absolute MAX_EVENTS cap.
//
// `currentBufferSeconds` is captured fresh at every call rather than stashed
// in module state — `evaluateRewind()` may update the user's bufferSeconds
// setting mid-buffer and we want subsequent trims to honor the new value.
export function pushRewindEvent(
  type: EventType,
  data: RewindEventData,
  currentBufferSeconds: number,
): void {
  buffer.push({ type, timestamp: Date.now(), data });
  trimRewindEvents(currentBufferSeconds);
}

// Drop events older than bufferSeconds + GRACE. Also enforce MAX_EVENTS cap
// by dropping the oldest if we're over.
export function trimRewindEvents(bufferSeconds: number): void {
  const cutoff = Date.now() - bufferSeconds * 1000 - GRACE_MS;
  // Drop expired from the front. Buffer is push-only at the end so entries
  // are roughly time-ordered; we can stop at the first non-expired entry.
  while (buffer.length > 0 && buffer[0].timestamp < cutoff) {
    buffer.shift();
  }
  // Hard cap.
  while (buffer.length > MAX_EVENTS) {
    buffer.shift();
  }
}

// Slice out the events that fall inside [endsAt - durationMs, endsAt] and
// rebase their timestamps to relativeTime against the window start.
//
// We return TimelineEvent[] without a recordingId — the upload path fills
// that in once the server has assigned an id. Local viewer doesn't need one
// (it uses the in-memory clip.events array directly).
export function extractRewindEventsWindow(
  durationMs: number,
  endsAt: number = Date.now(),
): ExtractedWindow {
  const windowStart = endsAt - durationMs;
  const slice: TimelineEvent[] = [];
  for (const entry of buffer) {
    if (entry.timestamp < windowStart || entry.timestamp > endsAt) continue;
    slice.push({
      // Local-only TimelineEvent — recordingId is set by the upload step.
      recordingId: '',
      type: entry.type,
      relativeTime: entry.timestamp - windowStart,
      data: entry.data,
    });
  }
  // Sort by relativeTime ascending. Buffer ordering is mostly time-ordered
  // but the 500ms-3.5s network matcher delay can push some network events
  // out of order vs. console / interaction events.
  slice.sort((a, b) => a.relativeTime - b.relativeTime);
  return { events: slice, startedAt: windowStart };
}

export function clearRewindEvents(): void {
  buffer.length = 0;
}

export function getRewindEventCount(): number {
  return buffer.length;
}
