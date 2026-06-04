// Rolling buffer for the Share Last Minute / Rewind feature.
//
// Design (Phase 1):
//
// A single continuous MediaRecorder runs on the active tab's media stream with
// timeslice = 1000ms. We keep a sliding window of recent chunks: chunks[0]
// (which carries the EBML header for the segment) is retained for the lifetime
// of the buffer, and any chunks whose accumulated timestamp falls outside the
// `bufferSeconds` window are dropped.
//
// Trade-off / known limitation: the resulting WebM is a single segment whose
// internal timestamps run continuously from t=0 of the MediaRecorder start.
// When we drop middle chunks the file remains *playable* (chunks[0] holds the
// codec config; subsequent chunks are Cluster elements which player implementations
// generally tolerate even when there's a time-gap), but playback will jump from
// the header to the surviving clusters. For Phase 1 this is acceptable because
// the feature has just started and the active tab usually hasn't been open
// long enough for chunk[0] to be ancient — most "last minute" finalizations
// will include the full minute. Phase 3 may revisit by either:
//   1) periodically rotating the MediaRecorder and remuxing on finalize, or
//   2) using webm-muxer for explicit segment authoring.
//
// We deliberately keep this module's state *separate* from offscreen.ts's
// primary-recording state (mediaRecorder/chunks/recordingId/startTime). Both
// can be live at the same time: a user may have rewind running while they also
// click "Start Recording" on the popup, in which case the SW pauses the rewind
// buffer to free resources and resumes when the primary recording ends.

import type { RewindStatusChangedMsg } from '@shared/types';
import { MSG } from '@shared/types';

export interface RewindBufferState {
  active: boolean;
  bufferedMs: number;
  startedAt: number | null;
}

interface Chunk {
  blob: Blob;
  // Wall-clock time when this chunk arrived. Used for sliding-window eviction.
  receivedAt: number;
}

let rewindRecorder: MediaRecorder | null = null;
let rewindStream: MediaStream | null = null;
let rewindChunks: Chunk[] = [];
let rewindStartedAt: number | null = null;
let rewindMimeType: string = 'video/webm';
let rewindBufferSeconds: number = 60;
let rewindTrackEndedHandler: (() => void) | null = null;
let rewindActiveTrack: MediaStreamTrack | null = null;
// Phase 6: persist the tab the running buffer is capturing. The SW reads this
// via REWIND_BUFFER_INFO on boot to discover whether a buffer survived a
// service-worker restart (which is exactly what we want — Chrome keeps this
// offscreen document alive as long as it holds a live USER_MEDIA MediaStream,
// per the offscreen lifecycle rules).
let rewindTabId: number | null = null;
let rewindHost: string | null = null;
// Audio passthrough: chrome.tabCapture mutes the source tab's speakers while
// the audio is being captured. We re-route the captured audio to the local
// output via an AudioContext so the user still hears the page they're on.
// The MediaRecorder continues to receive the same audio tracks from the
// original stream — splitting to destination does not remove them.
let rewindAudioCtx: AudioContext | null = null;
let rewindAudioSource: MediaStreamAudioSourceNode | null = null;

function pickMimeType(): string {
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) return 'video/webm;codecs=vp9,opus';
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) return 'video/webm;codecs=vp8,opus';
  return 'video/webm';
}

function broadcastStatus(status: 'enabled' | 'disabled', reason?: string): void {
  const msg: RewindStatusChangedMsg = {
    type: MSG.REWIND_STATUS_CHANGED,
    status:
      status === 'enabled'
        ? { status: 'enabled' }
        : { status: 'disabled', reason: reason || 'unknown' },
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// Drop chunks whose age exceeds the configured buffer window. chunks[0] (the
// header) is always retained — see the note at the top of the file.
function evictOldChunks(): void {
  if (rewindChunks.length <= 1) return;
  const now = Date.now();
  const cutoff = now - rewindBufferSeconds * 1000;
  // Keep header + anything newer than cutoff.
  const header = rewindChunks[0];
  let i = 1;
  while (i < rewindChunks.length && rewindChunks[i].receivedAt < cutoff) {
    i++;
  }
  if (i > 1) {
    rewindChunks = [header, ...rewindChunks.slice(i)];
  }
}

export async function startRewindBuffer(
  streamId: string,
  bufferSeconds: number,
  tabId: number,
  host: string,
): Promise<void> {
  // If already active, stop first so callers can treat this as idempotent.
  if (rewindRecorder) {
    stopRewindBuffer();
  }

  rewindBufferSeconds = bufferSeconds > 0 ? bufferSeconds : 60;
  rewindChunks = [];
  rewindStartedAt = null;
  // Phase 6: stash the capture target before any await so a concurrent
  // REWIND_BUFFER_INFO query during start-up gets a coherent answer.
  rewindTabId = tabId;
  rewindHost = host;

  try {
    // Chrome's "tab" media source requires the mandatory constraints object;
    // the @types/dom typings don't model this Chrome-specific API. The same
    // pattern is used in startTabCapture() in offscreen.ts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
        // Chrome-specific constraints — not in standard MediaStreamConstraints type
      } as unknown as MediaTrackConstraints,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      } as unknown as MediaTrackConstraints,
    });

    rewindStream = tabStream;
    rewindMimeType = pickMimeType();

    // Route captured tab audio back to the local speakers so the user can
    // still hear the page they're on. Without this, Chrome auto-mutes the
    // source tab as soon as tabCapture starts capturing its audio.
    const audioTracks = tabStream.getAudioTracks();
    if (audioTracks.length > 0) {
      try {
        rewindAudioCtx = new AudioContext();
        if (rewindAudioCtx.state === 'suspended') {
          await rewindAudioCtx.resume();
        }
        rewindAudioSource = rewindAudioCtx.createMediaStreamSource(
          new MediaStream(audioTracks),
        );
        rewindAudioSource.connect(rewindAudioCtx.destination);
      } catch {
        // If the AudioContext can't be created, capture still works — the
        // user just won't hear the tab while the buffer is running. Don't
        // abort the whole buffer for this.
        rewindAudioCtx = null;
        rewindAudioSource = null;
      }
    }

    // Lighter bitrate than the primary recording (which uses 2.5 Mbps).
    // The rewind buffer runs continuously, so we trade quality for less RAM use.
    rewindRecorder = new MediaRecorder(tabStream, {
      mimeType: rewindMimeType,
      videoBitsPerSecond: 1_800_000,
    });

    rewindRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) {
        rewindChunks.push({ blob: e.data, receivedAt: Date.now() });
        evictOldChunks();
      }
    };

    // If the tab's video track ends (tab closed / user navigated to a context
    // tabCapture can't reach) we tear down and broadcast.
    rewindActiveTrack = tabStream.getVideoTracks()[0] || null;
    if (rewindActiveTrack) {
      rewindTrackEndedHandler = () => {
        stopRewindBuffer();
        broadcastStatus('disabled', 'track-ended');
      };
      rewindActiveTrack.addEventListener('ended', rewindTrackEndedHandler);
    }

    rewindRecorder.start(1000);
    rewindStartedAt = Date.now();
    broadcastStatus('enabled');
  } catch (err) {
    cleanupRewindResources();
    broadcastStatus('disabled', (err as Error).message || 'start-failed');
    throw err;
  }
}

function cleanupRewindResources(): void {
  if (rewindActiveTrack && rewindTrackEndedHandler) {
    rewindActiveTrack.removeEventListener('ended', rewindTrackEndedHandler);
  }
  rewindActiveTrack = null;
  rewindTrackEndedHandler = null;

  if (rewindAudioSource) {
    try {
      rewindAudioSource.disconnect();
    } catch {
      // ignore
    }
  }
  rewindAudioSource = null;
  if (rewindAudioCtx) {
    rewindAudioCtx.close().catch(() => {});
  }
  rewindAudioCtx = null;

  if (rewindStream) {
    // Stopping every track here is what tells Chrome the USER_MEDIA reason
    // for keeping the offscreen doc alive is no longer in force. While at
    // least one captured track is live, Chrome will keep this offscreen
    // document around even across service-worker restarts — that's the
    // Phase 6 invariant the SW relies on to discover survived buffers via
    // REWIND_BUFFER_INFO.
    rewindStream.getTracks().forEach((t) => t.stop());
  }
  rewindStream = null;
  rewindRecorder = null;
  rewindChunks = [];
  rewindStartedAt = null;
  rewindTabId = null;
  rewindHost = null;
}

export function stopRewindBuffer(): void {
  if (rewindRecorder && rewindRecorder.state !== 'inactive') {
    try {
      rewindRecorder.stop();
    } catch {
      // ignore
    }
  }
  cleanupRewindResources();
}

// Stop the recorder and return the rolling buffer as a single ArrayBuffer.
// Returns null if there's nothing buffered or no active recorder.
export async function finalizeRewindBuffer(): Promise<
  { buffer: ArrayBuffer; mimeType: string; durationMs: number } | null
> {
  if (!rewindRecorder || !rewindStartedAt) return null;

  // Capture state we need before teardown.
  const startedAt = rewindStartedAt;
  const mimeType = rewindMimeType;
  const recorder = rewindRecorder;

  // Request a final dataavailable flush, then wait for it.
  // MediaRecorder fires one final ondataavailable on stop(), so we wait for onstop.
  await new Promise<void>((resolve) => {
    const onStop = () => {
      recorder.removeEventListener('stop', onStop);
      resolve();
    };
    recorder.addEventListener('stop', onStop);
    try {
      // requestData drains pending bytes before stop, helping include the tail
      // of the buffer even if the timeslice boundary hasn't tripped yet.
      if (recorder.state === 'recording') recorder.requestData();
      if (recorder.state !== 'inactive') recorder.stop();
      else resolve();
    } catch {
      resolve();
    }
  });

  // After eviction, rewindChunks holds the header + the last bufferSeconds worth.
  evictOldChunks();

  if (rewindChunks.length === 0) {
    cleanupRewindResources();
    return null;
  }

  const blob = new Blob(
    rewindChunks.map((c) => c.blob),
    { type: mimeType },
  );

  // Approximate duration: from the receivedAt of the second chunk (the first
  // post-header chunk we still hold) up to now. This isn't exact — the chunk
  // boundary doesn't equal the recorded media boundary — but it's close enough
  // for Phase 1's logging/preview purposes. Phase 3 (real upload) should compute
  // duration server-side from the WebM itself.
  // TODO(phase-3): replace with actual duration extracted from WebM metadata.
  let durationMs: number;
  if (rewindChunks.length >= 2) {
    durationMs = Date.now() - rewindChunks[1].receivedAt;
  } else {
    durationMs = Date.now() - startedAt;
  }
  durationMs = Math.max(0, Math.min(durationMs, rewindBufferSeconds * 1000));

  const buffer = await blob.arrayBuffer();
  cleanupRewindResources();
  return { buffer, mimeType, durationMs };
}

export function getRewindBufferState(): RewindBufferState {
  if (!rewindRecorder || !rewindStartedAt) {
    return { active: false, bufferedMs: 0, startedAt: null };
  }
  const now = Date.now();
  const sinceStart = now - rewindStartedAt;
  const bufferedMs = Math.min(sinceStart, rewindBufferSeconds * 1000);
  return { active: true, bufferedMs, startedAt: rewindStartedAt };
}

// Phase 6: cheap predicate the offscreen entry uses to answer
// REWIND_BUFFER_INFO. Returns true iff a MediaRecorder is currently running
// and capturing.
export function isRewindBufferActive(): boolean {
  return rewindRecorder !== null && rewindRecorder.state !== 'inactive';
}

// Phase 6: the tabId associated with the running buffer, or null when no
// buffer is active. Used by the SW boot path to hydrate `bufferedTabId`
// after a service-worker restart without tearing down a survived buffer.
export function getRewindBufferTabId(): number | null {
  return rewindTabId;
}

// Phase 6: the host string the SW had resolved when it started the buffer.
// Returned by REWIND_BUFFER_INFO so the SW can populate `bufferedHost` on the
// `enabledOnOtherTab` status without re-querying the tab.
export function getRewindBufferHost(): string | null {
  return rewindHost;
}

// Phase 6: the buffer-window length the buffer was started with (seconds).
// Needed by the SW boot path so the resumed event-capture pipeline uses the
// same window as the video buffer.
export function getRewindBufferSeconds(): number {
  return rewindBufferSeconds;
}
