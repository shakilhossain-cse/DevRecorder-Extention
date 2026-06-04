import { api } from '@shared/api';
import { MSG } from '@shared/types';
import type {
  RecordingState,
  ExtensionMessage,
  EventType,
  NetworkEventData,
  ConsoleEventData,
  NavigationEventData,
  InteractionEventData,
  CaptureMode,
  CropRect,
  RewindStatus,
  RewindStatusChangedMsg,
} from '@shared/types';
import {
  getRewindPreferences,
  setRewindPreferences,
  onRewindPreferencesChanged,
  isHostBlocked,
  isHostForceEnabled,
  isHostAutoDisabled,
  normalizeHost,
} from '@shared/rewind-storage';
import { isHostDefaultBlocked } from '@shared/rewind-default-blocklist';
import { startHeuristic, stopHeuristic } from './rewind-heuristic';
import { fixWebmDuration } from '../offscreen/fix-webm-duration';
import { saveRewindClip, purgeOldClips } from '@shared/rewind-clips-db';
import type { DeviceInfoSnapshot } from '@shared/rewind-clips-db';
import {
  pushRewindEvent,
  trimRewindEvents,
  extractRewindEventsWindow,
  clearRewindEvents,
} from './rewind-events';
import type { RewindEventData } from './rewind-events';

// Cap how many rewind clips we keep in IndexedDB. Each clip can run multiple
// MB, and the user-visible workflow is "save -> immediately open in viewer ->
// optionally upload"; older clips are intentionally throwaway, not an archive.
// 20 is generous enough to cover a debugging session without ballooning the
// browser profile size.
const REWIND_CLIPS_MAX = 20;

// Allow content scripts to access chrome.storage.session
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

// Redirect to feedback page when user uninstalls the extension
chrome.runtime.setUninstallURL('https://www.devrecorder.com/uninstall');

// ── Sensitive header redaction ──────────────────────────
const REDACTED = '[REDACTED]';
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'proxy-authorization',
  'www-authenticate',
  'x-access-token',
  'x-refresh-token',
  'x-session-id',
  'x-forwarded-for',
]);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    clean[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return clean;
}

// ── State ──────────────────────────────────────────────
let recording: RecordingState = {
  status: 'idle',
  id: null,
  tabId: null,
  startTime: null,
};

// Persist recording state to chrome.storage.session so it survives SW restarts
function persistRecordingState(): void {
  chrome.storage.session.set({ recordingState: { ...recording } }).catch(() => {});
}

// Restore recording state on SW startup
async function restoreRecordingState(): Promise<void> {
  try {
    const { recordingState } = await chrome.storage.session.get('recordingState');
    if (recordingState && recordingState.status !== 'idle') {
      recording = recordingState;
      // Resume listeners if we were recording
      if (recording.status === 'recording' || recording.status === 'paused' || recording.status === 'countdown') {
        startNetworkListeners();
        startNavigationListeners();
        startKeepalive();
        if (recording.status === 'recording') {
          chrome.action.setBadgeText({ text: 'REC' });
          chrome.action.setBadgeBackgroundColor({ color: '#dc3232' });
        } else if (recording.status === 'paused') {
          chrome.action.setBadgeText({ text: '⏸' });
        } else if (recording.status === 'countdown') {
          chrome.action.setBadgeText({ text: '...' });
          chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
        }
      } else if (recording.status === 'uploading') {
        chrome.action.setBadgeText({ text: 'UP' });
        chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
        startKeepalive();
      }
    }
  } catch {}
}

// Restore on SW startup
restoreRecordingState();

interface PendingRequest {
  url: string;
  method: string;
  type: string;
  startTime: number;
  initiator: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: string | null;
}

const pendingRequests = new Map<string, PendingRequest>();

// ── Event Buffer (batched flush to API) ────────────────
let eventBuffer: { type: string; relativeTime: number; data: Record<string, any> }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 2000;
const MAX_BUFFER_SIZE = 200;

function queueEvent(type: string, relativeTime: number, data: Record<string, any>): void {
  if (!recording.id) return;

  // Cap buffer to prevent unbounded growth if API is slow/down
  if (eventBuffer.length >= MAX_BUFFER_SIZE) {
    eventBuffer.shift();
  }
  eventBuffer.push({ type, relativeTime, data });

  if (!flushTimer) {
    flushTimer = setTimeout(flushEvents, FLUSH_INTERVAL);
  }
}

// ── Phase 5: capture target + event routing ───────────
// `rewindCaptureActive` tracks whether the rewind rolling buffer is currently
// capturing events on a tab. It is null whenever no rewind buffer is active
// (idle / blocked / paused-for-primary / etc.).
//
// Capture pipelines are mutually exclusive: the primary recording explicitly
// pauses the rewind buffer before starting (see pauseRewindForPrimary...).
// The shared webRequest / webNavigation listeners filter by whichever pipeline
// owns the current tab and route the event accordingly.
let rewindCaptureActive: {
  tabId: number;
  host: string;
  bufferSeconds: number;
} | null = null;

// Returns the tabId that capture listeners should accept events from, or null
// if neither pipeline is active. Used by the webRequest / webNavigation
// listeners to skip events from other tabs cheaply.
function captureTargetTabId(): number | null {
  if (
    recording.tabId !== null &&
    (recording.status === 'recording' ||
      recording.status === 'paused' ||
      recording.status === 'countdown')
  ) {
    return recording.tabId;
  }
  if (rewindCaptureActive) return rewindCaptureActive.tabId;
  return null;
}

// Routes a captured event to whichever pipeline is currently active:
//   - primary recording in progress -> queueEvent (with relativeTime from
//     recording.startTime). Note: events captured during 'countdown' or
//     'paused' status are not queued because the primary's startTime hasn't
//     been set / the recorder is paused.
//   - rewind capturing on this tab   -> pushRewindEvent (absolute timestamp)
//   - neither                         -> dropped (callers shouldn't have
//     gotten this far; listener filters already check captureTargetTabId).
//
// `absoluteEventTimestamp` is the wall-clock Date.now() at which the event
// was observed. For the primary pipeline we compute relativeTime from it.
function routeCapturedEvent(
  type: EventType,
  data: RewindEventData,
  absoluteEventTimestamp: number,
): void {
  if (recording.id && recording.status === 'recording' && recording.startTime !== null) {
    queueEvent(
      type,
      absoluteEventTimestamp - recording.startTime,
      data as unknown as Record<string, any>,
    );
    return;
  }
  if (rewindCaptureActive) {
    pushRewindEvent(type, data, rewindCaptureActive.bufferSeconds);
    return;
  }
  // No active capture — drop. Should be rare because the listener filters
  // already check captureTargetTabId; possible during state transitions.
}

function flushEvents(): void {
  flushTimer = null;
  if (eventBuffer.length === 0 || !recording.id) return;

  const batch = eventBuffer;
  eventBuffer = [];
  api.sendEvents(recording.id, batch).catch((err) => {
    // On failure, put events back for retry and persist to storage
    eventBuffer = [...batch, ...eventBuffer];
    persistBuffer();
    console.warn('[DevRecorder] Flush failed, buffered for retry:', err);
  });
  // Clear persisted backup on successful flush attempt
  chrome.storage.session.remove(['eventBufferBackup', 'eventBufferRecordingId']).catch(() => {});
}

// ── Message Router ─────────────────────────────────────
// ── Pending region selection state ─────────────────────
let pendingRegion: {
  tabId: number;
  tabTitle: string;
  tabUrl: string;
  resolve: (result: { success: boolean; recordingId?: string; error?: string }) => void;
} | null = null;

// ── Pending capture (waiting for user to grant screen permission) ──
let pendingCapture: {
  resolve: () => void;
  reject: (error: string) => void;
} | null = null;

chrome.runtime.onMessage.addListener(
  (msg: ExtensionMessage, _sender, sendResponse) => {
    switch (msg.type) {
      case MSG.START_RECORDING:
        startRecording(msg.tabId, msg.tabTitle, msg.tabUrl, msg.captureMode).then(sendResponse);
        return true;

      case MSG.STOP_RECORDING:
        stopRecording().then(sendResponse);
        return true;

      case MSG.RECORDING_STATE:
        sendResponse({ ...recording });
        return false;

      case MSG.RECORDING_SAVED:
        onRecordingSaved(msg.recordingId, msg.duration);
        return false;

      case MSG.CAPTURE_READY:
        if (pendingCapture) {
          pendingCapture.resolve();
          pendingCapture = null;
        }
        return false;

      case MSG.CAPTURE_FAILED:
        if (pendingCapture) {
          pendingCapture.reject((msg as any).error || 'Capture failed');
          pendingCapture = null;
        } else {
          handleCaptureFailed();
        }
        return false;

      case MSG.REGION_SELECTED:
        if (pendingRegion) {
          const { tabId, tabTitle, tabUrl, resolve } = pendingRegion;
          pendingRegion = null;
          beginRecordingWithRegion(tabId, tabTitle, tabUrl, msg.rect).then(resolve);
        }
        return false;

      case MSG.REGION_CANCELLED:
        if (pendingRegion) {
          pendingRegion.resolve({ success: false, error: 'Region selection cancelled' });
          pendingRegion = null;
        }
        return false;

      case MSG.CONSOLE_EVENT:
        if (recording.status === 'recording' || rewindCaptureActive !== null) {
          handleConsoleEvent(msg.data);
        }
        return false;

      case MSG.INTERACTION_EVENT:
        if (recording.status === 'recording' || rewindCaptureActive !== null) {
          handleInteractionEvent(msg.data);
        }
        return false;

      case MSG.TAKE_SCREENSHOT:
        takeScreenshot(msg.tabId, msg.tabTitle, msg.tabUrl, (msg as any).delay).then(sendResponse);
        return true;

      case MSG.SCREENSHOT_SAVE:
        handleScreenshotSave((msg as any).recordingId, (msg as any).imageDataUrl, (msg as any).title, (msg as any).description, (msg as any).fullscreenDataUrl).then(sendResponse);
        return true;

      case 'SCREENSHOT_CAPTURE' as any:
        handleScreenshotCapture((msg as any).cropRect, (msg as any).delay, _sender.tab?.id).then(sendResponse);
        return true;

      case MSG.COUNTDOWN_COMPLETE:
        if (recording.status === 'countdown') {
          // Resume the media recorder (was paused during countdown so countdown isn't captured)
          chrome.runtime.sendMessage({ type: MSG.RESUME_RECORDING }).catch(() => {});
          recording.status = 'recording';
          recording.startTime = Date.now();
          persistRecordingState();
          chrome.action.setBadgeText({ text: 'REC' });
          chrome.action.setBadgeBackgroundColor({ color: '#dc3232' });
          // Notify all injected tabs to start their timers
          for (const tabId of injectedTabs) {
            chrome.tabs.sendMessage(tabId, { type: 'DEVRECORDER_COUNTDOWN_DONE' }).catch(() => {});
          }
        }
        sendResponse({ success: true });
        return false;

      case MSG.PAUSE_RECORDING:
        if (recording.status === 'recording') {
          recording.status = 'paused';
          persistRecordingState();
          chrome.runtime.sendMessage({ type: MSG.PAUSE_RECORDING }).catch(() => {});
          chrome.action.setBadgeText({ text: '⏸' });
          // Notify all injected tabs
          for (const tabId of injectedTabs) {
            chrome.tabs.sendMessage(tabId, { type: 'DEVRECORDER_PAUSED' }).catch(() => {});
          }
        }
        sendResponse({ success: true });
        return false;

      case MSG.RESUME_RECORDING:
        if (recording.status === 'paused') {
          recording.status = 'recording';
          persistRecordingState();
          chrome.runtime.sendMessage({ type: MSG.RESUME_RECORDING }).catch(() => {});
          chrome.action.setBadgeText({ text: 'REC' });
          chrome.action.setBadgeBackgroundColor({ color: '#dc3232' });
          for (const tabId of injectedTabs) {
            chrome.tabs.sendMessage(tabId, { type: 'DEVRECORDER_RESUMED' }).catch(() => {});
            // Re-activate page-agent on resume
            chrome.scripting.executeScript({
              target: { tabId },
              func: () => { window.postMessage({ source: 'devrecorder-control', action: 'start' }, '*'); },
            }).catch(() => {});
          }
        }
        sendResponse({ success: true });
        return false;

      case MSG.REQUEST_MIC_PERMISSION:
        handleMicPermission().then(sendResponse);
        return true;

      case 'GET_VIDEO_DATA' as any:
        // Forward to offscreen document which holds the video blob
        chrome.runtime.sendMessage({ type: 'GET_VIDEO_DATA' }).then(sendResponse).catch(() => sendResponse({ success: false }));
        return true;

      case MSG.SHARE_LAST_MINUTE:
        handleShareLastMinute().then(sendResponse).catch((err) =>
          sendResponse({ success: false, error: (err as Error).message }),
        );
        return true;

      case MSG.REWIND_STATUS:
        sendResponse(currentRewindStatus());
        // Receiving this message from the popup is the user-gesture moment we
        // need to acquire a tab streamId. If the SW's last evaluation failed
        // without a gesture (or we're still in the bootstrap idle state),
        // re-attempt now under the popup's gesture.
        //
        // We re-evaluate only for the bootstrap cases — `needsPopupOpen` and
        // `idle`. We deliberately do NOT re-evaluate on `enabledOnOtherTab`:
        // the buffer is healthy on its tab, and the user must explicitly
        // request a swap (the popup offers Share-this-buffer vs Switch-capture).
        if (
          rewindStatus.status === 'needsPopupOpen' ||
          rewindStatus.status === 'idle'
        ) {
          evaluateRewind().catch(() => {});
        }
        return false;

      case MSG.FORCE_ENABLE_REWIND:
        handleForceEnableRewind(msg.host).then(sendResponse).catch((err) =>
          sendResponse({ success: false, error: (err as Error).message }),
        );
        return true;

      case MSG.UPDATE_REWIND_BLOCKLIST:
        handleUpdateRewindBlocklist(msg.action, msg.host).then(sendResponse).catch((err) =>
          sendResponse({ success: false, error: (err as Error).message }),
        );
        return true;

      case MSG.REWIND_SWITCH_TAB:
        // Phase 6: the popup wants the rolling buffer to move onto the tab
        // it's currently looking at. The popup-message context carries the
        // user gesture needed for tabCapture.getMediaStreamId on the target.
        handleRewindSwitchTab(msg.targetTabId).then(sendResponse).catch((err) =>
          sendResponse({ success: false, error: (err as Error).message }),
        );
        return true;

      default: {
        const raw = msg as any;
        // The offscreen rewind buffer broadcasts REWIND_STATUS_CHANGED directly
        // (e.g. when the captured track ends because the user closed the tab).
        // The offscreen still emits the legacy shape `{status:'enabled'}` /
        // `{status:'disabled', reason}`. The enabled case is compatible with
        // the new state machine; for the disabled case (essentially "the track
        // we were capturing is gone") we just clear our tab pointer, stop the
        // heuristic, and let evaluateRewind() recompute authoritative state.
        if (raw.type === MSG.REWIND_STATUS_CHANGED && raw.status) {
          const incoming = raw.status as { status: string };
          if (incoming.status === 'enabled') {
            // Don't clobber `forceEnabled` if that's what we set locally.
            if (rewindStatus.status !== 'enabled' && rewindStatus.status !== 'forceEnabled') {
              rewindStatus = { status: 'enabled' };
            }
          } else {
            // Legacy disabled broadcast — most commonly track-ended. Don't
            // try to map a free-form reason into the new union; just trigger
            // an evaluation which will produce the authoritative status.
            bufferedTabId = null;
            stopHeuristic();
            evaluateRewind().catch(() => {});
          }
          return false;
        }
        if (raw.type === 'MIC_PERMISSION_RESULT') {
          if (micPermissionResolve) {
            micPermissionResolve({ granted: raw.granted, error: raw.error });
            micPermissionResolve = null;
          }
          return false;
        }
        if (raw.type === 'AUTH_TOKEN_RECEIVED' && raw.token) {
          chrome.storage.local.set({ apiToken: raw.token });
          return false;
        }
        if (raw.type === 'AUTH_LOGOUT') {
          chrome.storage.local.remove('apiToken');
          return false;
        }
        if (
          raw.type === 'NETWORK_RESPONSE' &&
          (recording.status === 'recording' || rewindCaptureActive !== null)
        ) {
          handleNetworkResponse(raw.data);
        }
        return false;
      }
    }
  }
);

// ── Start Recording ────────────────────────────────────
async function startRecording(
  tabId: number,
  tabTitle: string,
  tabUrl: string,
  captureMode: CaptureMode = 'tab',
): Promise<{ success: boolean; recordingId?: string; error?: string }> {
  if (recording.status !== 'idle') {
    return { success: false, error: 'Already recording' };
  }

  if (captureMode === 'desktop') {
    // Desktop mode — use getDisplayMedia (shows picker for screen/window)
    return beginRecording(tabId, tabTitle, tabUrl, undefined, true);
  }

  if (captureMode === 'region') {
    // Inject region selector, then wait for REGION_SELECTED message
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/region-selector.js'],
      });
    } catch {
      return { success: false, error: 'Cannot inject region selector on this page' };
    }

    // Return a promise that resolves when region is selected
    return new Promise((resolve) => {
      pendingRegion = { tabId, tabTitle, tabUrl, resolve };
    });
  }

  // Tab mode  start directly
  return beginRecording(tabId, tabTitle, tabUrl, undefined, false);
}

async function beginRecording(
  tabId: number,
  tabTitle: string,
  tabUrl: string,
  cropRect?: CropRect,
  desktopMode = false,
): Promise<{ success: boolean; recordingId?: string; error?: string }> {
  try {
    const now = Date.now();

    // Detect incognito mode
    let isIncognito = false;
    try {
      const tab = await chrome.tabs.get(tabId);
      isIncognito = tab.incognito;
    } catch {}

    // Check mic permission status
    let micEnabled = false;
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try { return navigator.permissions.query({ name: 'microphone' as PermissionName }).then(p => p.state === 'granted'); } catch { return false; }
        },
      });
      micEnabled = result?.[0]?.result || false;
    } catch {}

    // Detect JS libraries on the page
    let detectedLibs: string[] = [];
    try {
      const libResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const libs: string[] = [];
          if ((window as any).React || document.querySelector('[data-reactroot]') || document.querySelector('#__next')) libs.push('React');
          if ((window as any).Vue || document.querySelector('[data-v-]')) libs.push('Vue');
          if ((window as any).angular || document.querySelector('[ng-app]') || document.querySelector('[ng-version]')) libs.push('Angular');
          if ((window as any).jQuery || (window as any).$?.fn?.jquery) libs.push('jQuery');
          if ((window as any).__NEXT_DATA__) libs.push('Next.js');
          if ((window as any).__NUXT__) libs.push('Nuxt');
          if (document.querySelector('meta[name="generator"][content*="WordPress"]')) libs.push('WordPress');
          if ((window as any).Shopify) libs.push('Shopify');
          if ((window as any).__svelte_meta) libs.push('Svelte');
          if ((window as any).__remixContext) libs.push('Remix');
          if (document.querySelector('script[src*="gatsby"]')) libs.push('Gatsby');
          if ((window as any).Webflow) libs.push('Webflow');
          if ((window as any)._satellite) libs.push('Adobe Launch');
          if ((window as any).gtag || (window as any).ga) libs.push('Google Analytics');
          if ((window as any).Sentry) libs.push('Sentry');
          if ((window as any).tailwind) libs.push('Tailwind CSS');
          return libs;
        },
      });
      detectedLibs = libResult?.[0]?.result || [];
    } catch {}

    const surface = cropRect ? 'region' : desktopMode ? 'desktop' : 'tab';

    const rec = await api.createRecording({
      title: tabTitle || 'Untitled Recording',
      url: tabUrl || '',
      startTime: now,
      duration: 0,
      mediaType: 'video',
      recordingSurface: surface,
      micEnabled,
      isIncognito,
      detectedLibs,
    });

    // The primary recording's ensureOffscreenDocument() closes + recreates the
    // offscreen doc, which would also destroy any active rewind buffer running
    // in it. Pause the rewind buffer before that happens; it will be resumed
    // in onRecordingSaved() once the primary recording flow is fully done.
    pauseRewindForPrimaryRecording();

    await ensureOffscreenDocument();

    if (cropRect) {
      // Region mode — needs getDisplayMedia for full-screen capture + canvas crop
      await chrome.runtime.sendMessage({
        type: MSG.BEGIN_CAPTURE,
        recordingId: rec._id,
        cropRect,
      });
    } else if (desktopMode) {
      // Desktop mode — use getDisplayMedia (allows screen/window picker)
      await chrome.runtime.sendMessage({
        type: MSG.BEGIN_CAPTURE,
        recordingId: rec._id,
        desktopMode: true,
      });
    } else {
      // Tab mode — use tabCapture for instant recording (no picker)
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      await chrome.runtime.sendMessage({
        type: MSG.BEGIN_TAB_CAPTURE,
        recordingId: rec._id,
        streamId,
      });
    }

    // Wait for CAPTURE_READY or CAPTURE_FAILED from offscreen
    try {
      await new Promise<void>((resolve, reject) => {
        pendingCapture = { resolve, reject };
      });
    } catch (captureError) {
      // Capture failed  clean up
      api.deleteRecording(rec._id).catch(() => {});
      return { success: false, error: String(captureError) };
    }

    startNetworkListeners();
    startNavigationListeners();

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js'],
      });
    } catch {
      // Content script may already be injected via manifest
    }

    // Activate page-agent on this tab
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { window.postMessage({ source: 'devrecorder-control', action: 'start' }, '*'); },
      });
    } catch { /* non-critical */ }

    if (desktopMode) {
      // Desktop mode: skip countdown, start recording immediately
      recording = {
        status: 'recording',
        id: rec._id,
        tabId,
        startTime: Date.now(),
      };
      persistRecordingState();
      chrome.action.setBadgeText({ text: 'REC' });
      chrome.action.setBadgeBackgroundColor({ color: '#dc3232' });

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content/drawing-overlay.js'],
        });
        injectedTabs.add(tabId);
      } catch {}
    } else {
      // Tab mode: pause recorder during countdown so countdown isn't captured
      chrome.runtime.sendMessage({ type: MSG.PAUSE_RECORDING }).catch(() => {});

      recording = {
        status: 'countdown',
        id: rec._id,
        tabId,
        startTime: null,
      };
      persistRecordingState();
      chrome.action.setBadgeText({ text: '...' });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content/drawing-overlay.js'],
        });
        injectedTabs.add(tabId);
      } catch {}
    }
    startKeepalive();

    // Capture device info at recording start
    captureDeviceInfo(tabId);

    // Capture storage snapshot from the page
    captureStorageSnapshot(tabId);

    return { success: true, recordingId: rec._id };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function beginRecordingWithRegion(
  tabId: number,
  tabTitle: string,
  tabUrl: string,
  cropRect: CropRect,
): Promise<{ success: boolean; recordingId?: string; error?: string }> {
  return beginRecording(tabId, tabTitle, tabUrl, cropRect);
}

function handleCaptureFailed(): void {
  // Clean up if user cancelled the screen picker
  if (recording.id) {
    api.deleteRecording(recording.id).catch(() => {});
  }
  removeOverlayFromAllTabs();
  stopNetworkListeners();
  stopNavigationListeners();
  chrome.action.setBadgeText({ text: '' });
  stopKeepalive();
  // Clear event buffer
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  eventBuffer = [];
  recording = { status: 'idle', id: null, tabId: null, startTime: null };
  persistRecordingState();
  // The offscreen doc was torn down by ensureOffscreenDocument(); re-evaluate
  // whether the rewind buffer should start back up.
  resumeRewindAfterPrimaryRecording();
}

async function uploadThumbnail(recordingId: string, dataUrl: string): Promise<void> {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    await api.uploadThumbnail(recordingId, blob);
  } catch {}
}

function deactivatePageAgent(tabId: number): void {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => { window.postMessage({ source: 'devrecorder-control', action: 'stop' }, '*'); },
  }).catch(() => {});
}

function removeOverlayFromAllTabs(): void {
  for (const tabId of injectedTabs) {
    chrome.tabs.sendMessage(tabId, { type: 'DEVRECORDER_REMOVE_DRAWING' }).catch(() => {});
    deactivatePageAgent(tabId);
  }
  injectedTabs.clear();
}

// ── Stop Recording ─────────────────────────────────────
async function stopRecording(): Promise<{
  success: boolean;
  recordingId?: string | null;
  error?: string;
}> {
  if (recording.status !== 'recording' && recording.status !== 'paused' && recording.status !== 'countdown') {
    return { success: false, error: 'Not recording' };
  }

  recording.status = 'stopping';

  try {
    // Flush remaining events before stopping
    flushEvents();

    // Deactivate page-agent on the recording tab
    if (recording.tabId) deactivatePageAgent(recording.tabId);

    await chrome.runtime.sendMessage({ type: MSG.STOP_RECORDING });
    stopNetworkListeners();
    stopNavigationListeners();

    // Remove drawing overlay from all injected tabs
    const savedTabId = recording.tabId;
    removeOverlayFromAllTabs();

    // Keep keepalive running  offscreen is uploading the video
    // It will be stopped when RECORDING_SAVED is received
    chrome.action.setBadgeText({ text: 'UP' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });

    const recId = recording.id;
    recording = { status: 'uploading', id: recId, tabId: null, startTime: null };
    persistRecordingState();

    // Inject the saved-modal overlay into the recording tab
    if (savedTabId && recId) {
      const shareLink = `https://www.devrecorder.com/share/${recId}`;
      const viewLink = `https://www.devrecorder.com/recordings/${recId}`;

      // Capture a screenshot of the tab as the video preview thumbnail
      let previewThumb = '';
      try {
        const tab = await chrome.tabs.get(savedTabId);
        previewThumb = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
      } catch {}

      // Upload thumbnail to R2 in background
      if (previewThumb) {
        uploadThumbnail(recId, previewThumb).catch(() => {});
      }

      chrome.storage.session.set({
        devrecorderSavedModal: { recId, shareLink, viewLink, previewThumb },
      }).catch(() => {});
      chrome.scripting.executeScript({
        target: { tabId: savedTabId },
        files: ['content/saved-modal.js'],
      }).catch(() => {});
    }

    return { success: true, recordingId: recId };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function onRecordingSaved(recordingId: string, duration: number): void {
  // If recording was stopped externally (e.g. "Stop sharing" button),
  // the status will still be 'recording'/'countdown'/'paused' — need full cleanup
  const wasExternalStop = recording.status === 'recording' || recording.status === 'paused' || recording.status === 'countdown';
  const savedTabId = recording.tabId;

  api.updateRecording(recordingId, { duration }).catch(() => {});

  if (wasExternalStop) {
    // Flush events
    flushEvents();
    // Deactivate page-agent
    if (savedTabId) deactivatePageAgent(savedTabId);
    stopNetworkListeners();
    stopNavigationListeners();
    // Remove drawing overlay
    removeOverlayFromAllTabs();

    // Inject saved modal (same as normal stopRecording flow)
    if (savedTabId && recordingId) {
      const shareLink = `https://www.devrecorder.com/share/${recordingId}`;
      const viewLink = `https://www.devrecorder.com/recordings/${recordingId}`;

      let previewThumb = '';
      chrome.tabs.get(savedTabId).then((tab) => {
        return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
      }).then((thumb) => {
        previewThumb = thumb;
      }).catch(() => {}).finally(() => {
        chrome.storage.session.set({
          devrecorderSavedModal: { recId: recordingId, shareLink, viewLink, previewThumb },
        }).catch(() => {});
        chrome.scripting.executeScript({
          target: { tabId: savedTabId },
          files: ['content/saved-modal.js'],
        }).catch(() => {});
      });
    }
  }

  recording = { status: 'idle', id: null, tabId: null, startTime: null };
  persistRecordingState();
  chrome.action.setBadgeText({ text: '' });
  stopKeepalive();
  // Clean up buffers
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  eventBuffer = [];
  responseBodyBuffer.length = 0;
  pendingRequests.clear();
  // Notify popup that upload is done
  chrome.storage.session.set({ uploadComplete: { recordingId, timestamp: Date.now() } });

  // Resume the rewind buffer now that the primary recording is finished.
  resumeRewindAfterPrimaryRecording();
}

// ── Offscreen Document ─────────────────────────────────
async function ensureOffscreenDocument(): Promise<void> {
  // Always close + recreate so getDisplayMedia works (it only fires once per doc)
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // No existing document  that's fine
  }
  // Small delay to ensure cleanup is complete
  await new Promise((r) => setTimeout(r, 100));
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DISPLAY_MEDIA' as chrome.offscreen.Reason],
    justification: 'Recording screen/window via getDisplayMedia',
  });
}

// ── Network Tracking ───────────────────────────────────
// The listeners below are shared between the primary recording pipeline and
// the rewind event-capture pipeline. They filter by captureTargetTabId() so
// only the tab owned by whichever pipeline is active gets recorded. Routing
// of finalized network events to the right pipeline is done in
// routeCapturedEvent().
function onBeforeRequest(
  details: Parameters<Parameters<typeof chrome.webRequest.onBeforeRequest.addListener>[0]>[0]
): chrome.webRequest.BlockingResponse | undefined {
  if (details.tabId !== captureTargetTabId()) return;
  // Skip CORS preflight requests
  if (details.method === 'OPTIONS') return;
  // Skip analytics and noise
  try {
    const u = new URL(details.url);
    const p = u.pathname;
    if (u.searchParams.has('_rsc')) return;
    // Google Analytics / Tag Manager
    if (u.hostname.includes('google-analytics.com')) return;
    if (u.hostname.includes('googletagmanager.com')) return;
    if (u.hostname.includes('google.com') && p.startsWith('/g/collect')) return;
    // Facebook pixel
    if (u.hostname.includes('facebook.com') && p.includes('/tr')) return;
    if (u.hostname.includes('connect.facebook.net')) return;
    // Hotjar, Clarity, Intercom, Crisp, Sentry
    if (u.hostname.includes('hotjar.com')) return;
    if (u.hostname.includes('clarity.ms')) return;
    if (u.hostname.includes('intercom.io')) return;
    if (u.hostname.includes('crisp.chat')) return;
    if (u.hostname.includes('sentry.io')) return;
    // Browser extension internal requests
    if (u.protocol === 'chrome-extension:') return;
  } catch {}

  let requestBody: string | null = null;
  if (details.requestBody) {
    if (details.requestBody.raw) {
      try {
        const decoder = new TextDecoder();
        const parts = details.requestBody.raw
          .filter((p) => p.bytes)
          .map((p) => decoder.decode(p.bytes));
        requestBody = parts.join('');
      } catch {
        requestBody = '[Binary data]';
      }
    } else if (details.requestBody.formData) {
      requestBody = JSON.stringify(details.requestBody.formData, null, 2);
    }
  }

  // Evict stale pending requests older than 30s
  if (pendingRequests.size > 100) {
    const cutoff = details.timeStamp - 30_000;
    for (const [id, req] of pendingRequests) {
      if (req.startTime < cutoff) pendingRequests.delete(id);
    }
  }

  pendingRequests.set(details.requestId, {
    url: details.url,
    method: details.method,
    type: details.type,
    startTime: details.timeStamp,
    initiator: details.initiator || '',
    requestHeaders: {},
    responseHeaders: {},
    requestBody,
  });
  return undefined;
}

function onSendHeaders(
  details: Parameters<Parameters<typeof chrome.webRequest.onSendHeaders.addListener>[0]>[0]
) {
  if (details.tabId !== captureTargetTabId()) return;
  const req = pendingRequests.get(details.requestId);
  if (!req || !details.requestHeaders) return;

  const headers: Record<string, string> = {};
  for (const h of details.requestHeaders) {
    if (h.name && h.value) headers[h.name] = h.value;
  }
  req.requestHeaders = redactHeaders(headers);
}

function onHeadersReceived(
  details: Parameters<Parameters<typeof chrome.webRequest.onHeadersReceived.addListener>[0]>[0]
): chrome.webRequest.BlockingResponse | undefined {
  if (details.tabId !== captureTargetTabId()) return;
  const req = pendingRequests.get(details.requestId);
  if (!req || !details.responseHeaders) return;

  const headers: Record<string, string> = {};
  for (const h of details.responseHeaders) {
    if (h.name && h.value) headers[h.name] = h.value;
  }
  req.responseHeaders = redactHeaders(headers);
  return undefined;
}

function onCompleted(
  details: Parameters<Parameters<typeof chrome.webRequest.onCompleted.addListener>[0]>[0]
) {
  if (details.tabId !== captureTargetTabId()) return;
  const req = pendingRequests.get(details.requestId);
  if (!req) return;
  pendingRequests.delete(details.requestId);

  const isXhr = req.type === 'xmlhttprequest';

  if (isXhr) {
    // XHR/fetch: delay to wait for page-agent's body interception. We resolve
    // the body match here (potentially after multiple retries) and only then
    // route the FULLY-FORMED event to whichever pipeline owns the tab now.
    // Note: in the rare case where a primary recording starts/stops between
    // onCompleted and emitEvent, the event may get routed to a different
    // pipeline than the one that captured the request — that's acceptable
    // (events are tied to whichever capture is active when they finalize).
    const emitEvent = (retriesLeft: number) => {
      const bodies = findResponseBody(req.method, req.url);
      if (!bodies && retriesLeft > 0) {
        setTimeout(() => emitEvent(retriesLeft - 1), retriesLeft > 1 ? 1000 : 2000);
        return;
      }

      const data: NetworkEventData = {
        url: req.url,
        method: req.method,
        resourceType: req.type,
        status: details.statusCode,
        statusLine: details.statusLine,
        duration: details.timeStamp - req.startTime,
        initiator: req.initiator,
        error: null,
        requestHeaders: req.requestHeaders,
        responseHeaders: req.responseHeaders,
        requestBody: bodies?.requestBody || req.requestBody,
        responseBody: bodies?.responseBody || null,
      };
      routeCapturedEvent('network', data, req.startTime);
    };
    setTimeout(() => emitEvent(2), 500);
  } else {
    // Static resources (JS, CSS, images, fonts, etc.): emit immediately, no body needed
    const data: NetworkEventData = {
      url: req.url,
      method: req.method,
      resourceType: req.type,
      status: details.statusCode,
      statusLine: details.statusLine,
      duration: details.timeStamp - req.startTime,
      initiator: req.initiator,
      error: null,
      requestHeaders: req.requestHeaders,
      responseHeaders: req.responseHeaders,
      requestBody: null,
      responseBody: null,
    };
    routeCapturedEvent('network', data, req.startTime);
  }
}

function onErrorOccurred(
  details: Parameters<Parameters<typeof chrome.webRequest.onErrorOccurred.addListener>[0]>[0]
) {
  if (details.tabId !== captureTargetTabId()) return;
  const req = pendingRequests.get(details.requestId);
  if (!req) return;
  pendingRequests.delete(details.requestId);

  const data: NetworkEventData = {
    url: req.url,
    method: req.method,
    resourceType: req.type,
    status: 0,
    statusLine: '',
    duration: details.timeStamp - req.startTime,
    initiator: req.initiator,
    error: details.error,
    requestHeaders: req.requestHeaders,
    responseHeaders: req.responseHeaders,
    requestBody: req.requestBody,
    responseBody: null,
  };
  routeCapturedEvent('network', data, req.startTime);
}

function startNetworkListeners(): void {
  const filter: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'] };
  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter, ['requestBody']);
  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, filter, ['requestHeaders']);
  chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, filter, ['responseHeaders']);
  chrome.webRequest.onCompleted.addListener(onCompleted, filter);
  chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, filter);
}

function stopNetworkListeners(): void {
  chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
  chrome.webRequest.onSendHeaders.removeListener(onSendHeaders);
  chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  chrome.webRequest.onCompleted.removeListener(onCompleted);
  chrome.webRequest.onErrorOccurred.removeListener(onErrorOccurred);
  pendingRequests.clear();
  responseBodyBuffer.length = 0;
}

// ── Navigation Tracking ────────────────────────────────
function onNavCommitted(
  details: chrome.webNavigation.WebNavigationTransitionCallbackDetails
): void {
  if (details.tabId !== captureTargetTabId() || details.frameId !== 0) return;
  const data: NavigationEventData = {
    url: details.url,
    transitionType: details.transitionType,
  };
  routeCapturedEvent('navigation', data, details.timeStamp);
}

function onHistoryStateUpdated(
  details: chrome.webNavigation.WebNavigationTransitionCallbackDetails
): void {
  if (details.tabId !== captureTargetTabId() || details.frameId !== 0) return;
  const data: NavigationEventData = {
    url: details.url,
    transitionType: 'spa_navigation',
  };
  routeCapturedEvent('navigation', data, details.timeStamp);
}

// Re-inject content scripts and drawing overlay after page reload/navigation.
// Triggers for the primary recording tab (drawing overlay + content script)
// and, for Phase 5, also for the rewind capture tab (content script only —
// rewind doesn't draw on the page).
function onNavCompleted(
  details: chrome.webNavigation.WebNavigationBaseCallbackDetails
): void {
  if (details.frameId !== 0) return;

  const primaryActive =
    recording.status === 'recording' ||
    recording.status === 'paused' ||
    recording.status === 'countdown';
  const primaryRelevant =
    primaryActive && (details.tabId === recording.tabId || injectedTabs.has(details.tabId));
  const rewindRelevant =
    !primaryActive &&
    rewindCaptureActive !== null &&
    details.tabId === rewindCaptureActive.tabId;

  if (!primaryRelevant && !rewindRelevant) return;

  // Content script (re-injects page-agent too).
  chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    files: ['content/content.js'],
  }).then(() => {
    // Re-activate page-agent after re-injection. Both pipelines need an
    // active page-agent so the fetch/XHR/console intercept fires.
    if (recording.status === 'recording' || rewindRelevant) {
      chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        func: () => { window.postMessage({ source: 'devrecorder-control', action: 'start' }, '*'); },
      }).catch(() => {});
    }
  }).catch(() => {});

  // Drawing overlay is primary-only — rewind doesn't paint on the page.
  if (primaryRelevant) {
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['content/drawing-overlay.js'],
    }).catch(() => {});
  }
}

function startNavigationListeners(): void {
  chrome.webNavigation.onCommitted.addListener(onNavCommitted);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onHistoryStateUpdated);
  chrome.webNavigation.onCompleted.addListener(onNavCompleted);
}

function stopNavigationListeners(): void {
  chrome.webNavigation.onCommitted.removeListener(onNavCommitted);
  chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistoryStateUpdated);
  chrome.webNavigation.onCompleted.removeListener(onNavCompleted);
}

// ── Console Event Handler ──────────────────────────────
function handleConsoleEvent(data: {
  level: string;
  args: string[];
  timestamp: number;
  stack: string;
}): void {
  const payload: ConsoleEventData = {
    level: data.level as ConsoleEventData['level'],
    args: data.args,
    stack: data.stack || '',
  };
  routeCapturedEvent('console', payload, data.timestamp);
}

function handleInteractionEvent(data: {
  action: 'click' | 'input' | 'scroll' | 'focus';
  selector: string;
  tag: string;
  text?: string;
  attributes: Record<string, string>;
  attrCount: number;
  timestamp: number;
}): void {
  const payload: InteractionEventData = {
    action: data.action,
    selector: data.selector,
    tag: data.tag,
    text: data.text,
    attributes: data.attributes,
    attrCount: data.attrCount,
  };
  routeCapturedEvent('interaction', payload, data.timestamp);
}

// ── Network Response Handler (from page-agent fetch/XHR intercept) ──
// Buffer response bodies, matched to webRequest events by method + URL
interface ResponseBodyEntry {
  method: string;
  url: string;
  requestBody: string | null;
  responseBody: string | null;
  addedAt: number;
}
const responseBodyBuffer: ResponseBodyEntry[] = [];
const MAX_RESPONSE_BUFFER = 100;

// Extract pathname from a URL for fuzzy matching
function urlPathname(raw: string): string {
  try { return new URL(raw).pathname; } catch { return raw; }
}

// Find a matching response body entry by method + URL (with fallback strategies)
function findResponseBody(method: string, url: string): ResponseBodyEntry | null {
  // 1. Exact match on method + full URL
  let idx = responseBodyBuffer.findIndex(e => e.method === method && e.url === url);

  // 2. Fallback: match method + pathname (ignore origin differences)
  if (idx === -1) {
    const path = urlPathname(url);
    idx = responseBodyBuffer.findIndex(e => e.method === method && urlPathname(e.url) === path);
  }

  // 3. Fallback: match method + URL ends with the same path
  if (idx === -1) {
    const path = urlPathname(url);
    idx = responseBodyBuffer.findIndex(e => e.method === method && e.url.endsWith(path));
  }

  if (idx === -1) return null;
  const entry = responseBodyBuffer[idx];
  responseBodyBuffer.splice(idx, 1);
  return entry;
}

function handleNetworkResponse(data: {
  url: string;
  method: string;
  status: number;
  requestBody: string | null;
  responseBody: string | null;
  timestamp: number;
}): void {
  // Evict oldest entries if buffer is full
  while (responseBodyBuffer.length >= MAX_RESPONSE_BUFFER) {
    responseBodyBuffer.shift();
  }

  // Evict stale entries older than 30s (unmatched responses)
  const now = Date.now();
  const STALE_MS = 10_000;
  while (responseBodyBuffer.length > 0 && now - responseBodyBuffer[0].addedAt > STALE_MS) {
    responseBodyBuffer.shift();
  }

  responseBodyBuffer.push({
    method: data.method.toUpperCase(),
    url: data.url,
    requestBody: data.requestBody,
    responseBody: data.responseBody,
    addedAt: now,
  });
}

// ── Tab Switch: inject drawing overlay on every active tab ──
const injectedTabs = new Set<number>();

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (recording.status !== 'recording' && recording.status !== 'countdown') return;

  const newTabId = activeInfo.tabId;

  // Update tracked tab  only this tab's events go to DB
  recording.tabId = newTabId;

  // Inject overlay into new tab (restores drawings from storage)
  // Don't remove from old tab  drawings persist there too
  if (!injectedTabs.has(newTabId)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: newTabId },
        files: ['content/content.js'],
      });
    } catch {
      // May fail on chrome:// pages etc.
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: newTabId },
        files: ['content/drawing-overlay.js'],
      });
      injectedTabs.add(newTabId);
    } catch {
      // Non-critical
    }
  }

  // Always activate page-agent on the newly focused tab
  try {
    await chrome.scripting.executeScript({
      target: { tabId: newTabId },
      func: () => { window.postMessage({ source: 'devrecorder-control', action: 'start' }, '*'); },
    });
  } catch { /* non-critical */ }
});

// ── Tab Close Handler ──────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  if ((recording.status === 'recording' || recording.status === 'countdown') && recording.tabId === tabId) {
    stopRecording();
  }
});

// ── Mic Permission via popup window ────────────────────
let micPermissionResolve: ((result: { granted: boolean; error?: string }) => void) | null = null;

async function handleMicPermission(): Promise<{ granted: boolean; error?: string }> {
  const display = await chrome.windows.getCurrent();
  return new Promise((resolve) => {
    micPermissionResolve = resolve;
    // Open a small centered window so Chrome can show the mic permission prompt
    const w = 360;
    const h = 200;
    const left = Math.round((display.left || 0) + ((display.width || 800) - w) / 2);
    const top = Math.round((display.top || 0) + ((display.height || 600) - h) / 2);
    chrome.windows.create({
      url: chrome.runtime.getURL('mic-permission.html'),
      type: 'popup',
      state: 'normal',
      width: w,
      height: h,
      left,
      top,
      focused: true,
    });
    // Timeout after 30s in case user closes the window without responding
    setTimeout(() => {
      if (micPermissionResolve) {
        micPermissionResolve({ granted: false, error: 'Timed out' });
        micPermissionResolve = null;
      }
    }, 30000);
  });
}

// Phase 5: snapshot device info for a rewind clip. Mirrors captureDeviceInfo
// but returns the snapshot instead of queueing it as a primary recording
// event — the snapshot is saved into the IDB clip record and used by the
// viewer / upload flow.
async function snapshotDeviceInfoForRewind(tabId: number): Promise<DeviceInfoSnapshot | undefined> {
  try {
    const [cpuInfo, memInfo] = await Promise.all([
      chrome.system.cpu.getInfo().catch(() => null),
      chrome.system.memory.getInfo().catch(() => null),
    ]);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: navigator.languages,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: (navigator as any).deviceMemory,
        onLine: navigator.onLine,
        connectionType: (navigator as any).connection?.effectiveType || null,
        connectionDownlink: (navigator as any).connection?.downlink || null,
        screenWidth: screen.width,
        screenHeight: screen.height,
        devicePixelRatio: window.devicePixelRatio,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezoneOffset: new Date().getTimezoneOffset(),
      }),
    });

    const browserInfo = (results?.[0]?.result || {}) as Record<string, unknown>;
    const snapshot: DeviceInfoSnapshot = {
      ...browserInfo,
      cpuArchName: cpuInfo?.archName || null,
      cpuModelName: cpuInfo?.modelName || null,
      cpuNumProcessors: cpuInfo?.numOfProcessors || null,
      memoryCapacityBytes: memInfo?.capacity || null,
      memoryAvailableBytes: memInfo?.availableCapacity || null,
    };
    return snapshot;
  } catch {
    return undefined;
  }
}

// ── Device Info Capture ──────────────────────────────
async function captureDeviceInfo(tabId: number): Promise<void> {
  try {
    const [cpuInfo, memInfo] = await Promise.all([
      chrome.system.cpu.getInfo().catch(() => null),
      chrome.system.memory.getInfo().catch(() => null),
    ]);

    // Get browser-level info from the tab
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: navigator.languages,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: (navigator as any).deviceMemory,
        onLine: navigator.onLine,
        connectionType: (navigator as any).connection?.effectiveType || null,
        connectionDownlink: (navigator as any).connection?.downlink || null,
        screenWidth: screen.width,
        screenHeight: screen.height,
        devicePixelRatio: window.devicePixelRatio,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezoneOffset: new Date().getTimezoneOffset(),
      }),
    });

    const browserInfo = results?.[0]?.result || {};

    queueEvent('device-info', 0, {
      ...browserInfo,
      cpuArchName: cpuInfo?.archName || null,
      cpuModelName: cpuInfo?.modelName || null,
      cpuNumProcessors: cpuInfo?.numOfProcessors || null,
      memoryCapacityBytes: memInfo?.capacity || null,
      memoryAvailableBytes: memInfo?.availableCapacity || null,
    });
  } catch {
    // Non-critical
  }
}

// ── Storage Snapshot Capture ─────────────────────────
async function captureStorageSnapshot(tabId: number): Promise<void> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const SENSITIVE = /^(password|passwd|secret|token|access_token|refresh_token|api_key|apikey|api_secret|authorization|private_key)$/i;

        function redactValue(key: string, val: string): string {
          return SENSITIVE.test(key) ? '[REDACTED]' : (val.length > 500 ? val.slice(0, 500) + '…' : val);
        }

        // localStorage
        const local: Record<string, string> = {};
        try {
          for (let i = 0; i < localStorage.length && i < 50; i++) {
            const key = localStorage.key(i);
            if (key) local[key] = redactValue(key, localStorage.getItem(key) || '');
          }
        } catch {}

        // sessionStorage
        const session: Record<string, string> = {};
        try {
          for (let i = 0; i < sessionStorage.length && i < 50; i++) {
            const key = sessionStorage.key(i);
            if (key) session[key] = redactValue(key, sessionStorage.getItem(key) || '');
          }
        } catch {}

        return {
          localStorage: local,
          localStorageCount: localStorage.length,
          sessionStorage: session,
          sessionStorageCount: sessionStorage.length,
        };
      },
    });

    const storageData = results?.[0]?.result;
    if (!storageData) return;

    // Also capture cookies for this tab's URL
    let cookies: { name: string; domain: string; secure: boolean; httpOnly: boolean }[] = [];
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url) {
        const allCookies = await chrome.cookies.getAll({ url: tab.url });
        cookies = allCookies.slice(0, 50).map((c) => ({
          name: c.name,
          domain: c.domain,
          secure: c.secure,
          httpOnly: c.httpOnly,
        }));
      }
    } catch {}

    queueEvent('storage', 0, {
      ...storageData,
      cookies,
      cookieCount: cookies.length,
    });
  } catch {
    // Non-critical
  }
}

// ── Offline Event Buffering ─────────────────────────
// Persist event buffer to chrome.storage.session so events survive SW restarts
async function persistBuffer(): Promise<void> {
  if (eventBuffer.length === 0) return;
  try {
    await chrome.storage.session.set({
      eventBufferBackup: eventBuffer,
      eventBufferRecordingId: recording.id,
    });
  } catch {}
}

async function restoreBuffer(): Promise<void> {
  try {
    const result = await chrome.storage.session.get([
      'eventBufferBackup',
      'eventBufferRecordingId',
    ]);
    const backup = result.eventBufferBackup as typeof eventBuffer | undefined;
    const backupRecId = result.eventBufferRecordingId as string | undefined;
    if (backup && backup.length > 0 && backupRecId && recording.id === backupRecId) {
      eventBuffer = [...backup, ...eventBuffer];
    }
    // Clear backup after restore
    chrome.storage.session.remove(['eventBufferBackup', 'eventBufferRecordingId']);
  } catch {}
}

// ── Service Worker Keepalive ───────────────────────────
const MAX_RECORDING_DURATION_MS = 60 * 60 * 1000; // 1 hour max

function startKeepalive(): void {
  chrome.alarms.create('devrecorder-keepalive', { periodInMinutes: 0.4 });
}

function stopKeepalive(): void {
  chrome.alarms.clear('devrecorder-keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'devrecorder-keepalive') {
    // Auto-stop if recording exceeds max duration
    if (recording.status === 'recording' && recording.startTime) {
      if (Date.now() - recording.startTime > MAX_RECORDING_DURATION_MS) {
        stopRecording();
      }
    }
    // Persist buffer periodically during recording
    if (recording.status === 'recording' && eventBuffer.length > 0) {
      persistBuffer();
    }
    // Stop keepalive if not recording or uploading
    if (recording.status === 'idle') {
      stopKeepalive();
    }
  } else if (alarm.name === REWIND_EVENTS_TRIM_ALARM) {
    // Phase 5: tick the rewind event buffer's trim. push-side trimming
    // handles steady-state; this alarm catches the case where pushes stop
    // arriving and the buffer would otherwise hold expired events.
    if (rewindCaptureActive) {
      trimRewindEvents(rewindCaptureActive.bufferSeconds);
    }
  }
});

// ── Screenshot Capture ──────────────────────────────
// Pending screenshot info (stored when popup triggers, used after selector completes)
let pendingScreenshotTab: { tabId: number; tabTitle: string; tabUrl: string } | null = null;

async function takeScreenshot(
  tabId: number,
  tabTitle: string,
  tabUrl: string,
  delay?: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Store tab info for when the selector reports back
    pendingScreenshotTab = { tabId, tabTitle, tabUrl };

    // Store delay if provided (selector will read it)
    if (delay && delay > 0) {
      await chrome.storage.session.set({ devrecorderScreenshotDelay: delay });
    }

    // Inject the selector overlay (click or drag to screenshot)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/screenshot-selector.js'],
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function handleScreenshotCapture(
  cropRect: { x: number; y: number; width: number; height: number } | null,
  delay: number,
  senderTabId?: number,
): Promise<{ success: boolean; error?: string }> {
  const tabInfo = pendingScreenshotTab;
  const tabId = senderTabId || tabInfo?.tabId;
  if (!tabId) return { success: false, error: 'No tab' };
  pendingScreenshotTab = null;

  try {
    // Optional delay for capturing hover states
    if (delay && delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    // Capture the visible tab as PNG
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
    });

    // If crop rect provided, crop the image
    let finalDataUrl = dataUrl;
    if (cropRect && cropRect.width > 0 && cropRect.height > 0) {
      // We'll crop in the content script since service worker has no canvas
      // Store full image + crop rect for the editor to handle
      await chrome.storage.session.set({
        devrecorderScreenshotCrop: cropRect,
      });
    }

    // Create a recording entry
    const title = tabInfo?.tabTitle || tab.title || 'Untitled';
    const url = tabInfo?.tabUrl || tab.url || '';

    // Detect libraries
    let detectedLibs: string[] = [];
    try {
      const libResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const libs: string[] = [];
          if ((window as any).React || document.querySelector('[data-reactroot]') || document.querySelector('#__next')) libs.push('React');
          if ((window as any).Vue || document.querySelector('[data-v-]')) libs.push('Vue');
          if ((window as any).angular || document.querySelector('[ng-app]')) libs.push('Angular');
          if ((window as any).jQuery || (window as any).$?.fn?.jquery) libs.push('jQuery');
          if ((window as any).__NEXT_DATA__) libs.push('Next.js');
          if ((window as any).__NUXT__) libs.push('Nuxt');
          if ((window as any).Shopify) libs.push('Shopify');
          if ((window as any).__svelte_meta) libs.push('Svelte');
          if ((window as any).__remixContext) libs.push('Remix');
          return libs;
        },
      });
      detectedLibs = libResult?.[0]?.result || [];
    } catch {}

    const rec = await api.createRecording({
      title: `Screenshot: ${title}`,
      url,
      startTime: Date.now(),
      duration: 0,
      mediaType: 'screenshot',
      isIncognito: tab.incognito,
      detectedLibs,
    });

    // Capture all context (device info, console, network, storage) in parallel
    captureScreenshotContext(rec._id, tabId);

    // Store screenshot data for the editor
    await chrome.storage.session.set({
      devrecorderScreenshot: {
        dataUrl: finalDataUrl,
        recordingId: rec._id,
      },
    });

    // Inject the screenshot editor
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/screenshot-editor.js'],
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function handleScreenshotSave(
  screenshotRecordingId: string,
  imageDataUrl: string,
  title?: string,
  description?: string,
  fullscreenDataUrl?: string | null,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Update title and description if provided
    const updateData: Record<string, string> = {};
    if (title) updateData.title = title;
    if (description) updateData.description = description;
    if (Object.keys(updateData).length > 0) {
      await api.updateRecording(screenshotRecordingId, updateData as any).catch(() => {});
    }

    // Upload the annotated/cropped screenshot
    const res = await fetch(imageDataUrl);
    const blob = await res.blob();
    await api.uploadScreenshot(screenshotRecordingId, blob);

    // Upload fullscreen screenshot as thumbnail if included
    if (fullscreenDataUrl && fullscreenDataUrl !== imageDataUrl) {
      try {
        const fullRes = await fetch(fullscreenDataUrl);
        const fullBlob = await fullRes.blob();
        await api.uploadThumbnail(screenshotRecordingId, fullBlob);
      } catch {}
    }

    // Notify completion
    chrome.storage.session.set({
      uploadComplete: { recordingId: screenshotRecordingId, timestamp: Date.now() },
    }).catch(() => {});

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function captureScreenshotContext(screenshotRecordingId: string, tabId: number): Promise<void> {
  const events: { type: string; relativeTime: number; data: Record<string, any> }[] = [];

  // ── 1. Device Info ────────────────────────────────
  try {
    const [cpuInfo, memInfo] = await Promise.all([
      chrome.system.cpu.getInfo().catch(() => null),
      chrome.system.memory.getInfo().catch(() => null),
    ]);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: navigator.languages,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: (navigator as any).deviceMemory,
        onLine: navigator.onLine,
        connectionType: (navigator as any).connection?.effectiveType || null,
        connectionDownlink: (navigator as any).connection?.downlink || null,
        screenWidth: screen.width,
        screenHeight: screen.height,
        devicePixelRatio: window.devicePixelRatio,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezoneOffset: new Date().getTimezoneOffset(),
      }),
    });

    const browserInfo = results?.[0]?.result || {};

    events.push({
      type: 'device-info',
      relativeTime: 0,
      data: {
        ...browserInfo,
        cpuArchName: cpuInfo?.archName || null,
        cpuModelName: cpuInfo?.modelName || null,
        cpuNumProcessors: cpuInfo?.numOfProcessors || null,
        memoryCapacityBytes: memInfo?.capacity || null,
        memoryAvailableBytes: memInfo?.availableCapacity || null,
      },
    });
  } catch { /* non-critical */ }

  // ── 2. Console Logs (intercept and collect from page) ──
  try {
    const consoleResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const logs: { level: string; args: string[]; stack: string }[] = [];

        // Collect from our buffer if page-agent stored any
        const buf = (window as any).__devrecorder_console_buffer;
        if (Array.isArray(buf)) {
          buf.forEach((entry: any) => {
            logs.push({
              level: entry.level || 'log',
              args: Array.isArray(entry.args) ? entry.args : [String(entry.args)],
              stack: entry.stack || '',
            });
          });
        }

        // Also check for JS errors in the page's error overlay elements
        const errorEls = document.querySelectorAll(
          '[class*="error" i]:not(style):not(script), [id*="error" i]:not(style):not(script)'
        );
        const seen = new Set<string>();
        errorEls.forEach((el) => {
          const text = (el as HTMLElement).innerText?.trim();
          if (text && text.length > 5 && text.length < 500 && !seen.has(text)) {
            seen.add(text);
            logs.push({ level: 'error', args: [text], stack: '' });
          }
        });

        return logs.slice(0, 50);
      },
    });

    const consoleLogs = consoleResults?.[0]?.result || [];
    consoleLogs.forEach((log: any) => {
      events.push({
        type: 'console',
        relativeTime: 0,
        data: { level: log.level, args: log.args, stack: log.stack || '' },
      });
    });
  } catch { /* non-critical */ }

  // ── 3. Network Requests (from page-agent buffer — has method, status, bodies) ──
  try {
    const networkResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const buf = (window as any).__devrecorder_network_buffer;
        if (!Array.isArray(buf)) return [];
        return buf.map((e: any) => ({
          url: e.url,
          method: e.method,
          status: e.status,
          duration: e.duration,
          requestBody: e.requestBody,
          responseBody: e.responseBody,
          timestamp: e.timestamp,
        }));
      },
    });

    const networkEntries = networkResults?.[0]?.result || [];
    networkEntries.forEach((entry: any) => {
      events.push({
        type: 'network',
        relativeTime: 0,
        data: {
          url: entry.url,
          method: entry.method || 'GET',
          resourceType: 'xmlhttprequest',
          status: entry.status || 0,
          statusLine: entry.status ? `${entry.status}` : '',
          duration: entry.duration || 0,
          initiator: '',
          error: null,
          requestHeaders: {},
          responseHeaders: {},
          requestBody: entry.requestBody || null,
          responseBody: entry.responseBody || null,
        },
      });
    });

  } catch { /* non-critical */ }

  // ── 3c. Static resources from Performance API (JS, CSS, images, fonts) ──
  try {
    const perfResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        const typeMap: Record<string, string> = {
          script: 'script', css: 'stylesheet', link: 'stylesheet',
          img: 'image', image: 'image', font: 'font',
          video: 'media', audio: 'media',
        };
        return entries
          .filter(e => e.initiatorType !== 'xmlhttprequest' && e.initiatorType !== 'fetch')
          .slice(-50)
          .map(e => {
            let status = 0;
            try { status = (e as any).responseStatus || 0; } catch {}
            return {
              url: e.name,
              resourceType: typeMap[e.initiatorType] || e.initiatorType || 'other',
              duration: Math.round(e.duration),
              status,
              transferSize: e.transferSize || 0,
              startTime: Math.round(e.startTime),
            };
          });
      },
    });

    const perfEntries = perfResults?.[0]?.result || [];
    perfEntries.forEach((entry: any) => {
      events.push({
        type: 'network',
        relativeTime: entry.startTime,
        data: {
          url: entry.url,
          method: 'GET',
          resourceType: entry.resourceType,
          status: entry.status,
          statusLine: entry.status ? `${entry.status}` : '',
          duration: entry.duration,
          initiator: '',
          error: null,
          requestHeaders: {},
          responseHeaders: {},
          requestBody: null,
          responseBody: null,
          transferSize: entry.transferSize,
        },
      });
    });
  } catch { /* non-critical */ }

  // ── 3b. User Interactions (from page-agent buffer) ──
  try {
    const interactionResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const buf = (window as any).__devrecorder_interaction_buffer;
        if (!Array.isArray(buf)) return [];
        return buf.map((e: any) => ({
          action: e.action,
          selector: e.selector,
          tag: e.tag,
          text: e.text,
          timestamp: e.timestamp,
        }));
      },
    });

    const interactions = interactionResults?.[0]?.result || [];
    interactions.forEach((entry: any) => {
      events.push({
        type: 'interaction',
        relativeTime: 0,
        data: {
          action: entry.action,
          selector: entry.selector,
          tag: entry.tag,
          text: entry.text,
          attributes: {},
          attrCount: 0,
        },
      });
    });
  } catch { /* non-critical */ }

  // ── 4. Storage Snapshot (localStorage, sessionStorage, cookies) ──
  try {
    const storageResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const SENSITIVE = /^(password|passwd|secret|token|access_token|refresh_token|api_key|apikey|api_secret|authorization|private_key)$/i;
        function redactValue(key: string, val: string): string {
          return SENSITIVE.test(key) ? '[REDACTED]' : (val.length > 500 ? val.slice(0, 500) + '\u2026' : val);
        }

        const local: Record<string, string> = {};
        try {
          for (let i = 0; i < localStorage.length && i < 50; i++) {
            const key = localStorage.key(i);
            if (key) local[key] = redactValue(key, localStorage.getItem(key) || '');
          }
        } catch {}

        const session: Record<string, string> = {};
        try {
          for (let i = 0; i < sessionStorage.length && i < 50; i++) {
            const key = sessionStorage.key(i);
            if (key) session[key] = redactValue(key, sessionStorage.getItem(key) || '');
          }
        } catch {}

        return {
          localStorage: local,
          localStorageCount: localStorage.length,
          sessionStorage: session,
          sessionStorageCount: sessionStorage.length,
        };
      },
    });

    const storageData = storageResults?.[0]?.result;
    if (storageData) {
      // Also capture cookies
      let cookies: { name: string; domain: string; secure: boolean; httpOnly: boolean }[] = [];
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url) {
          const allCookies = await chrome.cookies.getAll({ url: tab.url });
          cookies = allCookies.slice(0, 50).map((c) => ({
            name: c.name,
            domain: c.domain,
            secure: c.secure,
            httpOnly: c.httpOnly,
          }));
        }
      } catch {}

      events.push({
        type: 'storage',
        relativeTime: 0,
        data: {
          ...storageData,
          cookies,
          cookieCount: cookies.length,
        },
      });
    }
  } catch { /* non-critical */ }

  // ── Send all events in one batch ──────────────────
  if (events.length > 0) {
    api.sendEvents(screenshotRecordingId, events).catch(() => {});
  }
}

// Restore buffered events on service worker startup (in case SW was killed mid-recording)
chrome.storage.session.get('eventBufferRecordingId').then(({ eventBufferRecordingId }) => {
  if (eventBufferRecordingId) {
    // There was a recording in progress when SW died — restore buffer
    restoreBuffer().then(() => {
      if (eventBuffer.length > 0 && recording.id) {
        flushEvents();
      }
    });
  }
}).catch(() => {});

// ──────────────────────────────────────────────────────────────────────
// Share Last Minute / Rewind — Phase 2
// ──────────────────────────────────────────────────────────────────────
//
// Owns the lifecycle of the rolling buffer that lives in the offscreen doc:
//   • Decides on which active tab the buffer should run.
//   • Consults the user blocklist, force-enable list, and heuristic
//     auto-disable list (rewind-storage.ts host lists).
//   • Calls tabCapture.getMediaStreamId from the SW.
//   • Tracks our local view of the rewind status and broadcasts changes.
//   • Drives the CPU/memory pressure heuristic (rewind-heuristic.ts) only
//     while the buffer is in the `enabled` state.
//
// Phase 3 will hook the finalize payload into the upload pipeline + viewer
// launch. For Phase 2 the finalize path logs and stores the buffer locally
// for inspection.

let rewindStatus: RewindStatus = { status: 'idle' };
// Phase 6: the tab currently being captured by the rolling buffer. This is
// DISTINCT from the user's currently-active tab (chrome.tabs.query returns
// that one fresh in evaluateRewind). The buffer persists on `bufferedTabId`
// across tab switches; mismatch is surfaced via `enabledOnOtherTab` status,
// not a teardown. Set when we start the buffer; cleared on stop / finalize /
// buffered-tab close. Survives SW restart via the REWIND_BUFFER_INFO probe.
let bufferedTabId: number | null = null;
let bufferedHost: string | null = null;
// When the primary recording is running we mark the rewind as paused so the
// active-tab listeners don't keep trying to restart it on every tab switch.
let rewindPausedForPrimary: boolean = false;

function currentRewindStatus(): RewindStatus {
  return rewindStatus;
}

// Structural equality for the RewindStatus union — used to dedupe broadcasts.
function isSameRewindStatus(a: RewindStatus, b: RewindStatus): boolean {
  if (a.status !== b.status) return false;
  switch (a.status) {
    case 'enabled':
    case 'fileBlocked':
    case 'fullyDisabled':
    case 'browserInternal':
    case 'needsPopupOpen':
    case 'idle':
      return true;
    case 'forceEnabled':
    case 'autoDisabled':
    case 'urlBlocked':
    case 'defaultBlocked':
      return a.host === (b as { host: string }).host;
    case 'enabledOnOtherTab': {
      const other = b as Extract<RewindStatus, { status: 'enabledOnOtherTab' }>;
      return (
        a.bufferedHost === other.bufferedHost &&
        a.bufferedTabId === other.bufferedTabId &&
        a.activeHost === other.activeHost
      );
    }
    default: {
      // Exhaustiveness check.
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

function setRewindStatus(next: RewindStatus): void {
  if (isSameRewindStatus(rewindStatus, next)) return;
  rewindStatus = next;
  const msg: RewindStatusChangedMsg = { type: MSG.REWIND_STATUS_CHANGED, status: next };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// Non-destructive offscreen-doc check: ensure a doc exists without closing an
// existing one (the primary-recording flow's ensureOffscreenDocument() destroys
// the doc to give getDisplayMedia a fresh state — we don't want that here).
async function ensureOffscreenForRewind(): Promise<void> {
  // chrome.runtime.getContexts is available in MV3 (Chrome 116+); fall back to
  // try/catch on createDocument if not.
  type RuntimeWithContexts = typeof chrome.runtime & {
    getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
  };
  const rt = chrome.runtime as RuntimeWithContexts;
  if (typeof rt.getContexts === 'function') {
    try {
      const contexts = await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts && contexts.length > 0) return;
    } catch {
      // fall through to create
    }
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
      justification: 'Maintain rolling buffer of last minute of tab video for Share Last Minute',
    });
  } catch (err) {
    // If it already exists, Chrome throws. Swallow.
    const message = (err as Error).message || '';
    if (!/Only a single offscreen/.test(message)) throw err;
  }
}

// Classify a URL into the (browser-internal | file:// | capturable) buckets.
// The caller still has to consult the user blocklist + auto-disable list on
// top of this.
type UrlClassification = 'capturable' | 'fileBlocked' | 'browserInternal';

function classifyUrl(url: string | undefined): UrlClassification {
  if (!url) return 'browserInternal';
  if (/^file:/i.test(url)) return 'fileBlocked';
  // Browser-internal schemes that tabCapture can't touch.
  if (/^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search|chrome-untrusted):/i.test(url)) {
    return 'browserInternal';
  }
  // The Chrome Web Store also blocks tabCapture.
  if (/^https?:\/\/chrome\.google\.com\/webstore\b/.test(url)) return 'browserInternal';
  if (/^https?:\/\/chromewebstore\.google\.com\b/.test(url)) return 'browserInternal';
  return 'capturable';
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function stopRewindIfActive(): Promise<void> {
  // Always stop the heuristic when transitioning away from `enabled` — even
  // if the offscreen buffer was never actually running, the sampler may be
  // mid-loop from a prior tick.
  stopHeuristic();
  // Phase 5: tear down event capture in lockstep with the video buffer.
  // Safe to call when event capture isn't running.
  stopRewindEventCapture();
  if (bufferedTabId === null) {
    bufferedHost = null;
    return;
  }
  bufferedTabId = null;
  bufferedHost = null;
  try {
    await chrome.runtime.sendMessage({ type: MSG.REWIND_STOP });
  } catch {
    // Offscreen doc may already be gone.
  }
}

// ── Phase 5: rewind event capture lifecycle ──────────────────────────
// These run alongside the rolling video buffer. The shared webRequest /
// webNavigation listeners are reused (see Section 3 of the Phase 5 spec):
// captureTargetTabId() returns the rewind tab when no primary recording is
// running, so events from that tab are routed to the rewind buffer via
// routeCapturedEvent().
//
// Lifecycle order matters:
//   start  -> ensure listeners are attached, inject content + page-agent,
//             activate page-agent, set rewindCaptureActive, start trim alarm
//   stop   -> clear rewindCaptureActive, deactivate page-agent (if primary
//             isn't using it), detach listeners (if primary isn't using
//             them), clear trim alarm, clearRewindEvents()
const REWIND_EVENTS_TRIM_ALARM = 'devrecorder-rewind-events-trim';

function startRewindEventCapture(tabId: number, host: string, bufferSeconds: number): void {
  // Switching tabs: tear down old before standing up new.
  if (rewindCaptureActive && rewindCaptureActive.tabId !== tabId) {
    stopRewindEventCapture();
  }
  rewindCaptureActive = { tabId, host, bufferSeconds };

  // Listeners are idempotent (Chrome dedupes by reference), so calling
  // startNetworkListeners / startNavigationListeners while the primary
  // recording also has them attached is a no-op. The shared filter via
  // captureTargetTabId() handles routing.
  startNetworkListeners();
  startNavigationListeners();

  // Inject + activate page-agent on the tab. Idempotent — page-agent guards
  // against double-init with its window._devrecorderPageAgent flag.
  chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content.js'],
  }).then(() => {
    return chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.postMessage({ source: 'devrecorder-control', action: 'start' }, '*');
      },
    });
  }).catch(() => {
    // Non-critical: chrome:// pages etc. won't accept injection. Status
    // gating in evaluateRewind() should have prevented this case anyway.
  });

  // Periodic trim — defends against runaway pages where events arrive faster
  // than they age out via push-side trimming.
  chrome.alarms.create(REWIND_EVENTS_TRIM_ALARM, { periodInMinutes: 5 / 60 });
}

function stopRewindEventCapture(): void {
  if (!rewindCaptureActive) return;
  const previousTabId = rewindCaptureActive.tabId;
  rewindCaptureActive = null;

  // Detach listeners only if the primary pipeline isn't using them.
  const primaryActive =
    recording.status === 'recording' ||
    recording.status === 'paused' ||
    recording.status === 'countdown';
  if (!primaryActive) {
    stopNetworkListeners();
    stopNavigationListeners();
  }

  // Deactivate the page-agent on this tab — but only if the primary isn't
  // recording it. The page-agent's `active` flag is per-window; toggling it
  // off mid-primary-recording would silence the primary's intercept.
  if (!primaryActive || recording.tabId !== previousTabId) {
    chrome.scripting.executeScript({
      target: { tabId: previousTabId },
      func: () => {
        window.postMessage({ source: 'devrecorder-control', action: 'stop' }, '*');
      },
    }).catch(() => {});
  }

  chrome.alarms.clear(REWIND_EVENTS_TRIM_ALARM).catch(() => {});
  clearRewindEvents();
}

// Resolve the active tab's URL to a normalized host, or null when there isn't
// a parseable URL. Used both for gating and for the heuristic's attribution
// key. We hand the raw hostname through to the rewind-storage helpers which
// do their own normalization internally for matches, but we also normalize
// once here so the value we surface in `urlBlocked` / `autoDisabled` / etc.
// is consistent with the lists.
function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return normalizeHost(u.hostname);
  } catch {
    return null;
  }
}

// Try to acquire a tab streamId from the SW. This may fail without a user
// gesture (Chrome requires activeTab-style permission for the call). When it
// fails we fall back to the "disabled - needs-popup-open" reason; opening the
// popup re-runs this in a user-gesture context which succeeds.
async function tryGetTabStreamId(tabId: number): Promise<string | null> {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    return streamId || null;
  } catch {
    return null;
  }
}

// Re-evaluate which tab (if any) should be running the rewind buffer right now.
// Idempotent — called on extension startup, tab activation, tab updates, when
// preferences change, after force-enable / blocklist mutations, and after the
// heuristic flips a host into autoDisabledHosts.
//
// ────────────────────────────────────────────────────────────────────
// Phase 6 invariant — the rolling buffer PERSISTS across tab changes.
// ────────────────────────────────────────────────────────────────────
// Once bootstrapped (which still requires a one-time user gesture via the
// popup-open path), the buffer runs continuously on whichever tab it was
// bootstrapped on (`bufferedTabId`). Subsequent tab switches surface as
// `enabledOnOtherTab`, NOT a teardown. This matches jam.dev's "Instant
// Replay" UX. Tab-switch teardowns must not be re-added; only the following
// events tear the buffer down:
//   - the buffered tab itself is closed (chrome.tabs.onRemoved)
//   - preferences.globallyEnabled flips to false
//   - the heuristic auto-disables the buffered host
//   - the buffered host gets blocked (user list or default list) AND we're
//     still on that tab as the active tab
//   - a primary recording starts (pause flow) / finalize succeeds
//
// Decision tree (first match wins):
//   1. Primary recording in progress         -> leave alone
//   2. globallyEnabled === false             -> STOP, fullyDisabled
//   3. No active tab                         -> if buffer alive elsewhere,
//                                                enabledOnOtherTab; else idle
//   4. file:// active tab                    -> if buffer alive elsewhere,
//                                                enabledOnOtherTab;
//                                                else fileBlocked (no stop)
//   5. browser-internal active tab           -> same shape as file://
//   6. active host on blockedHosts (no force)
//      OR active host default-blocked (no force)
//      OR active host auto-disabled (no force)
//         -> if buffer alive on a DIFFERENT tab,  enabledOnOtherTab
//         -> if buffer is on THIS tab,            STOP, set blocked status
//         -> if no buffer alive,                  set blocked status
//   7. active host is capturable:
//      a. buffer alive on activeTabId           -> affirm enabled/forceEnabled
//      b. buffer alive on a DIFFERENT tab       -> try acquire streamId for
//                                                  the active tab; on success
//                                                  swap; on failure leave the
//                                                  old buffer alone and emit
//                                                  enabledOnOtherTab
//      c. no buffer alive                       -> try acquire streamId; on
//                                                  success start buffer; on
//                                                  failure -> needsPopupOpen
async function evaluateRewind(): Promise<void> {
  // While the user is actively recording, leave the rewind paused; we'll
  // re-evaluate on resume.
  if (rewindPausedForPrimary) return;
  // Also leave it alone if a primary recording is mid-flight regardless of the
  // explicit pause flag — defense in depth.
  if (
    recording.status === 'countdown' ||
    recording.status === 'recording' ||
    recording.status === 'paused' ||
    recording.status === 'stopping' ||
    recording.status === 'uploading'
  ) {
    return;
  }

  const preferences = await getRewindPreferences();
  if (!preferences.globallyEnabled) {
    await stopRewindIfActive();
    setRewindStatus({ status: 'fullyDisabled' });
    return;
  }

  const tab = await getActiveTab();
  const activeTabId = tab?.id ?? null;
  const activeUrl = tab?.url;

  // Helper: if a buffer is alive on a different tab than the active one, emit
  // `enabledOnOtherTab` so the popup can offer a "switch capture" affordance.
  // Returns true if it emitted such a status (caller should bail).
  const emitOtherTabIfBuffered = (activeHostForOther: string): boolean => {
    if (
      bufferedTabId !== null &&
      bufferedHost &&
      bufferedTabId !== activeTabId
    ) {
      setRewindStatus({
        status: 'enabledOnOtherTab',
        bufferedHost,
        bufferedTabId,
        activeHost: activeHostForOther,
      });
      return true;
    }
    return false;
  };

  if (!tab || activeTabId === null || activeTabId === chrome.tabs.TAB_ID_NONE) {
    // No active tab in our last-focused window. If the buffer is alive on
    // some other tab, surface that — the user just doesn't have a normal
    // tab in focus right now (e.g. devtools focused). Otherwise idle.
    if (bufferedTabId !== null && bufferedHost) {
      setRewindStatus({
        status: 'enabledOnOtherTab',
        bufferedHost,
        bufferedTabId,
        activeHost: '',
      });
      return;
    }
    await stopRewindIfActive();
    setRewindStatus({ status: 'idle' });
    return;
  }

  const classification = classifyUrl(activeUrl);
  if (classification === 'fileBlocked') {
    // Phase 6: do NOT stop the buffer just because the active tab is a
    // file:// page. If we're capturing a normal site in another tab, keep
    // capturing it — the user can switch back.
    if (emitOtherTabIfBuffered('')) return;
    setRewindStatus({ status: 'fileBlocked' });
    return;
  }
  if (classification === 'browserInternal') {
    if (emitOtherTabIfBuffered('')) return;
    setRewindStatus({ status: 'browserInternal' });
    return;
  }

  const host = hostFromUrl(activeUrl);
  if (!host) {
    // Parseable scheme but no hostname (data:, blob: roots, etc.) — treat
    // like browser-internal.
    if (emitOtherTabIfBuffered('')) return;
    setRewindStatus({ status: 'browserInternal' });
    return;
  }

  // Host-gating layer. Three lists collapse into the same shape: the active
  // tab's host is rejected unless the user has force-enabled it. The
  // important Phase 6 distinction: if the buffer is alive on a DIFFERENT
  // tab whose host is fine, we keep it alive and just report `enabledOnOtherTab`.
  // If the buffer is on the SAME tab as the active tab and that tab's host
  // just became blocked, we DO stop (URL gating still wins for the buffered
  // tab itself).
  const forceEnabled = isHostForceEnabled(preferences, host);
  const blockedReason: { status: 'urlBlocked' | 'defaultBlocked' | 'autoDisabled' } | null =
    !forceEnabled && isHostBlocked(preferences, host)
      ? { status: 'urlBlocked' }
      : !forceEnabled && isHostDefaultBlocked(host)
        ? { status: 'defaultBlocked' }
        : !forceEnabled && isHostAutoDisabled(preferences, host)
          ? { status: 'autoDisabled' }
          : null;

  if (blockedReason) {
    if (bufferedTabId !== null && bufferedTabId !== activeTabId && bufferedHost) {
      // Buffer is on a different tab — that tab's host is still fine, so
      // keep capturing. Surface the on-other-tab status to the user.
      setRewindStatus({
        status: 'enabledOnOtherTab',
        bufferedHost,
        bufferedTabId,
        activeHost: host,
      });
      return;
    }
    // Buffer is on THIS tab (or no buffer) — apply the blocked status and
    // stop if running.
    await stopRewindIfActive();
    setRewindStatus({ status: blockedReason.status, host });
    return;
  }

  // 7a. Buffer already running on the user's currently-active tab — affirm
  //     the appropriate enabled/forceEnabled status (which may have flipped
  //     since last evaluation) and keep the heuristic in the correct mode.
  if (bufferedTabId === activeTabId && bufferedHost === host) {
    if (forceEnabled) {
      setRewindStatus({ status: 'forceEnabled', host });
      stopHeuristic();
    } else {
      setRewindStatus({ status: 'enabled' });
      startHeuristic(host);
    }
    // Phase 5: defensive — if event capture isn't running for this tab
    // (e.g. SW restart re-hydrated the buffer without restarting capture),
    // start it. If it's running for the right tab already, this is a no-op.
    if (!rewindCaptureActive || rewindCaptureActive.tabId !== activeTabId) {
      startRewindEventCapture(activeTabId, host, preferences.bufferSeconds);
    }
    return;
  }

  // 7b. Buffer alive but on a DIFFERENT tab. Do NOT auto-swap on popup-open —
  //     swapping would destroy the buffered minute the user explicitly bootstrapped
  //     on the other tab, defeating the whole "persistent" promise. Just emit
  //     `enabledOnOtherTab`. The user can:
  //       - click Share Last Minute to capture what's already in the buffer
  //         (the buffered tab's last 60s), or
  //       - explicitly request a switch via REWIND_SWITCH_TAB (a dedicated
  //         affordance in the popup; that flow has its own user-gesture context).
  if (bufferedTabId !== null && bufferedHost) {
    setRewindStatus({
      status: 'enabledOnOtherTab',
      bufferedHost,
      bufferedTabId,
      activeHost: host,
    });
    return;
  }

  // 7c. No buffer alive anywhere — bootstrap from scratch.
  const streamId = await tryGetTabStreamId(activeTabId);
  if (!streamId) {
    setRewindStatus({ status: 'needsPopupOpen' });
    return;
  }
  await startNewBuffer(streamId, activeTabId, host, preferences.bufferSeconds, forceEnabled);
}

// Phase 6: shared "start a fresh buffer on tabId" path. Extracted out of
// evaluateRewind so REWIND_SWITCH_TAB can use the same setup. Caller is
// responsible for stopping any prior buffer first (we do not re-check here).
async function startNewBuffer(
  streamId: string,
  tabId: number,
  host: string,
  bufferSeconds: number,
  forceEnabled: boolean,
): Promise<void> {
  try {
    await ensureOffscreenForRewind();
    const res = await chrome.runtime.sendMessage({
      type: MSG.REWIND_START,
      streamId,
      bufferSeconds,
      tabId,
      host,
    });
    if (res && res.success) {
      bufferedTabId = tabId;
      bufferedHost = host;
      if (forceEnabled) {
        setRewindStatus({ status: 'forceEnabled', host });
        stopHeuristic();
      } else {
        setRewindStatus({ status: 'enabled' });
        startHeuristic(host);
      }
      startRewindEventCapture(tabId, host, bufferSeconds);
    } else {
      setRewindStatus({ status: 'needsPopupOpen' });
    }
  } catch {
    setRewindStatus({ status: 'needsPopupOpen' });
  }
}

// Phase 6: handle the popup's explicit "switch capture to this tab" click.
// The popup-message channel carries the user gesture we need for
// getMediaStreamId on the target tab. The path is essentially the same as
// evaluateRewind's 7b "swap on success" branch but bypasses every other gate
// (the popup only sends this when it has already shown `enabledOnOtherTab`).
async function handleRewindSwitchTab(targetTabId: number): Promise<{ success: boolean; error?: string }> {
  if (rewindPausedForPrimary) return { success: false, error: 'primary-recording-active' };
  if (
    recording.status === 'countdown' ||
    recording.status === 'recording' ||
    recording.status === 'paused' ||
    recording.status === 'stopping' ||
    recording.status === 'uploading'
  ) {
    return { success: false, error: 'primary-recording-active' };
  }

  const preferences = await getRewindPreferences();
  if (!preferences.globallyEnabled) {
    return { success: false, error: 'fully-disabled' };
  }

  // Re-resolve target host from the tab we're switching to — same gating as
  // evaluateRewind (file://, browser-internal, blocklists) applies before
  // we touch the buffer.
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(targetTabId);
  } catch {
    return { success: false, error: 'tab-not-found' };
  }
  const classification = classifyUrl(tab.url);
  if (classification !== 'capturable') {
    return { success: false, error: classification };
  }
  const host = hostFromUrl(tab.url);
  if (!host) return { success: false, error: 'invalid-host' };

  const forceEnabled = isHostForceEnabled(preferences, host);
  if (!forceEnabled && isHostBlocked(preferences, host)) {
    return { success: false, error: 'url-blocked' };
  }
  if (!forceEnabled && isHostDefaultBlocked(host)) {
    return { success: false, error: 'default-blocked' };
  }
  if (!forceEnabled && isHostAutoDisabled(preferences, host)) {
    return { success: false, error: 'auto-disabled' };
  }

  const streamId = await tryGetTabStreamId(targetTabId);
  if (!streamId) {
    // The popup gesture should have made this work; the most likely cause
    // is a race where the popup closed before the message landed. Fall back
    // to needsPopupOpen so the next popup-open kicks the normal flow.
    setRewindStatus({ status: 'needsPopupOpen' });
    return { success: false, error: 'no-gesture' };
  }

  // Tear down the old buffer (if any) before standing up the new one.
  await stopRewindIfActive();
  await startNewBuffer(streamId, targetTabId, host, preferences.bufferSeconds, forceEnabled);

  // Final sanity: ensure the buffer actually came up. startNewBuffer sets
  // either an `enabled`/`forceEnabled` or `needsPopupOpen` status — we only
  // call this a success if we landed on the former.
  if (rewindStatus.status === 'enabled' || rewindStatus.status === 'forceEnabled') {
    return { success: true };
  }
  return { success: false, error: 'buffer-failed-to-start' };
}

// Called from beginRecording() to free resources while the primary recording
// runs. The primary recording's ensureOffscreenDocument() tears down the
// offscreen page entirely, so the buffer's MediaRecorder is destroyed along
// with it — we just track the paused flag here so the listeners don't try to
// restart while the primary flow owns the offscreen doc.
function pauseRewindForPrimaryRecording(): void {
  rewindPausedForPrimary = true;
  bufferedTabId = null;
  bufferedHost = null;
  stopHeuristic();
  // Phase 5: tear down event capture so the primary recording's pipeline
  // owns the page-agent + webRequest listeners exclusively. clearRewindEvents
  // inside stopRewindEventCapture also frees the buffered events — we don't
  // need them after starting a primary recording.
  stopRewindEventCapture();
  // The popup will never see this in practice (it's closed during recording),
  // but `idle` is the most-honest representation: the buffer isn't running and
  // no UI tooltip needs to explain why.
  setRewindStatus({ status: 'idle' });
}

function resumeRewindAfterPrimaryRecording(): void {
  rewindPausedForPrimary = false;
  // Don't block onRecordingSaved on this; fire and forget.
  evaluateRewind().catch(() => {});
}

// Snapshot of the tab the user was on when they clicked Share Last Minute.
// We grab this BEFORE the async finalize round-trip so a mid-finalize tab
// navigation doesn't end up labeling the clip with the wrong host/url/title.
interface ShareTabSnapshot {
  host: string;
  url: string;
  title: string;
}

function snapshotActiveTab(): Promise<ShareTabSnapshot> {
  return getActiveTab().then((tab) => {
    const url = tab?.url || '';
    let host = '';
    if (url) {
      try {
        host = new URL(url).hostname;
      } catch {
        host = '';
      }
    }
    // Fall back to the SW's tracked rewind host if the tab query failed (e.g.
    // because the popup just stole focus). That value was set when the buffer
    // started, so it matches what we just finalized.
    if (!host && bufferedHost) host = bufferedHost;
    return {
      host,
      url,
      title: tab?.title || '',
    };
  });
}

function broadcastClipSaved(clipId: string, durationMs: number, sizeBytes: number): void {
  chrome.runtime
    .sendMessage({ type: MSG.REWIND_CLIP_SAVED, clipId, durationMs, sizeBytes })
    .catch(() => {});
}

function broadcastClipSaveFailed(error: string): void {
  chrome.runtime
    .sendMessage({ type: MSG.REWIND_CLIP_SAVE_FAILED, error })
    .catch(() => {});
}

// Phase 3 handler for the popup's SHARE_LAST_MINUTE click. Finalizes the
// rolling buffer, persists the resulting WebM to IndexedDB, opens the viewer
// to that clip, and broadcasts a save-confirmation so the popup can self-close.
//
// Failure modes are surfaced via REWIND_CLIP_SAVE_FAILED so the popup can show
// an inline error — we do NOT open the viewer on failure.
async function handleShareLastMinute(): Promise<{
  success: boolean;
  clipId?: string;
  durationMs?: number;
  bytes?: number;
  error?: string;
}> {
  // `enabled` and `forceEnabled` both mean the buffer is actively running on
  // the active tab. Every other status means we have nothing to finalize.
  if (rewindStatus.status !== 'enabled' && rewindStatus.status !== 'forceEnabled') {
    return { success: false, error: `rewind-not-active: ${rewindStatus.status}` };
  }

  // 1. Snapshot the tab now — the user might navigate while the finalize
  //    round-trip is in flight.
  const tabSnapshot = await snapshotActiveTab();

  // Capture the rewind tab id BEFORE finalize because the success branch nulls
  // out bufferedTabId / rewindCaptureActive. Phase 5 needs this id for the
  // device-info snapshot before tear-down.
  const rewindTabIdForCapture =
    rewindCaptureActive?.tabId ?? bufferedTabId ?? null;

  let finalizeResult: { buffer: number[]; mimeType: string; durationMs: number } | null = null;

  try {
    // 2. Drive the offscreen flush + stop.
    const res = await chrome.runtime.sendMessage({ type: MSG.REWIND_FINALIZE });
    // After finalize, the offscreen module clears its state — mark stopped here
    // and let evaluateRewind() restart on the same tab if appropriate.
    bufferedTabId = null;
    bufferedHost = null;
    stopHeuristic();
    if (!res || !res.success) {
      const err = (res && res.error) || 'finalize-failed';
      setRewindStatus({ status: 'needsPopupOpen' });
      broadcastClipSaveFailed(err);
      // Phase 5: drop the now-orphaned buffered events. evaluateRewind()
      // will spin up a fresh capture pipeline.
      stopRewindEventCapture();
      // Try to restart for next time.
      evaluateRewind().catch(() => {});
      return { success: false, error: err };
    }
    finalizeResult = {
      buffer: Array.isArray(res.buffer) ? res.buffer : [],
      mimeType: typeof res.mimeType === 'string' ? res.mimeType : 'video/webm',
      durationMs: typeof res.durationMs === 'number' ? res.durationMs : 0,
    };
  } catch (err) {
    bufferedTabId = null;
    bufferedHost = null;
    stopHeuristic();
    stopRewindEventCapture();
    const message = (err as Error).message || 'finalize-failed';
    setRewindStatus({ status: 'needsPopupOpen' });
    broadcastClipSaveFailed(message);
    evaluateRewind().catch(() => {});
    return { success: false, error: message };
  }

  // 3. Reconstruct the blob in SW context.
  const { buffer, mimeType, durationMs } = finalizeResult;
  if (buffer.length === 0) {
    broadcastClipSaveFailed('empty-buffer');
    stopRewindEventCapture();
    evaluateRewind().catch(() => {});
    return { success: false, error: 'empty-buffer' };
  }

  try {
    const rawBlob = new Blob([new Uint8Array(buffer)], { type: mimeType });

    // 4. Patch the WebM duration header so the viewer can seek/scrub. The
    //    function is pure Blob/Uint8Array/DataView so it's SW-safe.
    let fixedBlob: Blob;
    try {
      fixedBlob = await fixWebmDuration(rawBlob, durationMs);
    } catch {
      // Patching is best-effort — fall back to the raw blob if it throws.
      fixedBlob = rawBlob;
    }

    // Phase 5: extract the events window aligned to the captured-video tail.
    // The window ends at Date.now() (approximating the time the user clicked
    // Share Last Minute) and is durationMs long. Buffered events outside the
    // window are dropped.
    const { events: clipEvents } = extractRewindEventsWindow(durationMs);

    // Phase 5: snapshot device info while we still have a valid tab handle.
    // Best-effort — chrome:// pages or closed tabs return undefined.
    let deviceInfo: DeviceInfoSnapshot | undefined;
    if (rewindTabIdForCapture !== null) {
      deviceInfo = await snapshotDeviceInfoForRewind(rewindTabIdForCapture);
    }

    // 5. Persist to IndexedDB. Events + deviceInfo ride along (Phase 5).
    const clipId = await saveRewindClip(fixedBlob, {
      durationMs,
      mimeType,
      host: tabSnapshot.host,
      sourceTabUrl: tabSnapshot.url,
      sourceTabTitle: tabSnapshot.title,
      events: clipEvents,
      deviceInfo,
    });

    // Only AFTER successful save do we drop the events buffer. If save errors
    // out, the buffer survives so the user could (in theory) retry — currently
    // there's no UI for that, but it costs nothing to be conservative here.
    stopRewindEventCapture();

    // 6. Cap storage. Best-effort — don't fail the save if purge errors out.
    try {
      await purgeOldClips(REWIND_CLIPS_MAX);
    } catch {
      // ignore
    }

    // 7. The popup now handles the post-save display via an inline modal
    //    (rendered when REWIND_CLIP_SAVED arrives). We no longer pop open the
    //    viewer tab automatically — the user explicitly clicks "Open in
    //    Viewer" from the popup if they want the full timeline UI. The viewer
    //    URL (viewer.html?rewindClipId=…) still works for that path.

    // 8. Notify the popup. It loads the clip and renders the rewind-saved
    //    modal in-place.
    broadcastClipSaved(clipId, durationMs, fixedBlob.size);

    // 9. Restart the buffer for the next click.
    evaluateRewind().catch(() => {});

    return { success: true, clipId, durationMs, bytes: fixedBlob.size };
  } catch (err) {
    const message = (err as Error).message || 'save-failed';
    broadcastClipSaveFailed(message);
    evaluateRewind().catch(() => {});
    return { success: false, error: message };
  }
}

// ── Phase 2 message handlers ─────────────────────────────────────────
// Both handlers mutate rewind_preferences and then call evaluateRewind(),
// rather than poking rewindStatus directly. The storage write also fires the
// onRewindPreferencesChanged subscription, so there's a second evaluateRewind
// queued — that's fine, evaluateRewind() is idempotent.

async function handleForceEnableRewind(rawHost: string): Promise<{ success: boolean; error?: string }> {
  const host = normalizeHost(rawHost || '');
  if (!host) return { success: false, error: 'invalid-host' };
  const current = await getRewindPreferences();
  // Add to forceEnabledHosts (deduped) and drop from autoDisabledHosts.
  const forceEnabledHosts = current.forceEnabledHosts.some((h) => normalizeHost(h) === host)
    ? current.forceEnabledHosts
    : [...current.forceEnabledHosts, host];
  const autoDisabledHosts = current.autoDisabledHosts.filter((h) => normalizeHost(h) !== host);
  await setRewindPreferences({ forceEnabledHosts, autoDisabledHosts });
  await evaluateRewind();
  return { success: true };
}

async function handleUpdateRewindBlocklist(
  action: 'add' | 'remove',
  rawHost: string,
): Promise<{ success: boolean; error?: string }> {
  const host = normalizeHost(rawHost || '');
  if (!host) return { success: false, error: 'invalid-host' };
  const current = await getRewindPreferences();
  let blockedHosts = current.blockedHosts;
  let forceEnabledHosts = current.forceEnabledHosts;
  if (action === 'add') {
    if (!blockedHosts.some((h) => normalizeHost(h) === host)) {
      blockedHosts = [...blockedHosts, host];
    }
    // An explicit block trumps any prior force-enable override.
    forceEnabledHosts = forceEnabledHosts.filter((h) => normalizeHost(h) !== host);
    await setRewindPreferences({ blockedHosts, forceEnabledHosts });
  } else {
    blockedHosts = blockedHosts.filter((h) => normalizeHost(h) !== host);
    await setRewindPreferences({ blockedHosts });
  }
  await evaluateRewind();
  return { success: true };
}

// ── Triggers that re-evaluate the rewind buffer ──────────────────────

// Phase 6: SW-restart resilience. Before the first evaluateRewind() on
// startup, ask the offscreen doc whether a buffer survived the service-
// worker death. Chrome keeps an offscreen document alive while it holds a
// USER_MEDIA MediaStream — that's exactly the case here, so the offscreen
// doc + its MediaRecorder + chunks are still in memory. We just need to
// re-hydrate our local pointers (bufferedTabId, bufferedHost) so the next
// evaluateRewind() takes branch 7a ("buffer is already on the active tab")
// or branch 7b ("buffer is on a different tab") instead of tearing it down.
async function bootstrapRewindFromOffscreen(): Promise<void> {
  // If chrome.runtime.getContexts isn't available or returns no offscreen
  // doc, there is nothing to hydrate; the normal evaluateRewind() path will
  // bootstrap from scratch (and likely emit needsPopupOpen until the popup
  // is opened).
  type RuntimeWithContexts = typeof chrome.runtime & {
    getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
  };
  const rt = chrome.runtime as RuntimeWithContexts;
  if (typeof rt.getContexts === 'function') {
    try {
      const contexts = await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!contexts || contexts.length === 0) {
        await evaluateRewind();
        return;
      }
    } catch {
      // Fall through to the buffer-info probe anyway.
    }
  }

  let info: {
    active?: boolean;
    tabId?: number | null;
    host?: string | null;
    bufferSeconds?: number;
  } | null = null;
  try {
    info = await chrome.runtime.sendMessage({ type: MSG.REWIND_BUFFER_INFO });
  } catch {
    info = null;
  }

  if (info && info.active && typeof info.tabId === 'number' && info.host) {
    // Survived buffer found. Hydrate local pointers and let evaluateRewind()
    // re-affirm the status; it will take 7a / 7b / blocked depending on
    // what the active tab is right now.
    bufferedTabId = info.tabId;
    bufferedHost = info.host;
    // Re-establish event capture on the buffered tab so the next Share
    // Last Minute clip carries events too. startRewindEventCapture is
    // idempotent — the inner tab-mismatch check inside it handles
    // double-call cases.
    if (typeof info.bufferSeconds === 'number' && info.bufferSeconds > 0) {
      startRewindEventCapture(info.tabId, info.host, info.bufferSeconds);
    }
  }

  await evaluateRewind();
}

// Run once on SW start. The bootstrap path probes the offscreen doc first to
// avoid tearing down a buffer that outlived the service worker.
bootstrapRewindFromOffscreen().catch(() => {});

chrome.tabs.onActivated.addListener(() => {
  // Phase 6: do NOT teardown the buffer here — evaluateRewind() will simply
  // emit `enabledOnOtherTab` if the user's new active tab is different from
  // the buffered tab.
  evaluateRewind().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Only re-evaluate when the page has finished navigating; intermediate
  // states (loading, title changes, etc.) don't affect capture.
  if (changeInfo.status !== 'complete') return;
  // Phase 6 special case: the BUFFERED tab navigated to a new URL. The host
  // may have changed; if the new host hits a blocklist we need to stop the
  // buffer even if it's not the user's active tab. Handled inline so we
  // don't have to bake a "buffered-tab host check" branch into evaluateRewind.
  if (tabId === bufferedTabId) {
    handleBufferedTabNavigated(tabId).catch(() => {});
    return;
  }
  evaluateRewind().catch(() => {});
});

// Phase 6: the buffered tab finished a navigation. Re-check whether the new
// host is still capturable; if it's now blocked, stop the buffer (regardless
// of which tab the user is currently looking at).
async function handleBufferedTabNavigated(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    // Tab vanished — onRemoved will handle teardown.
    return;
  }
  const classification = classifyUrl(tab.url);
  if (classification !== 'capturable') {
    await stopRewindIfActive();
    await evaluateRewind();
    return;
  }
  const host = hostFromUrl(tab.url);
  if (!host) {
    await stopRewindIfActive();
    await evaluateRewind();
    return;
  }
  const preferences = await getRewindPreferences();
  const forceEnabled = isHostForceEnabled(preferences, host);
  if (!forceEnabled && (
    isHostBlocked(preferences, host) ||
    isHostDefaultBlocked(host) ||
    isHostAutoDisabled(preferences, host)
  )) {
    // Buffered tab navigated onto a blocked host — stop.
    await stopRewindIfActive();
    await evaluateRewind();
    return;
  }
  // Host is fine; just update bufferedHost and let evaluateRewind() pick a
  // new status (it will likely become enabledOnOtherTab if the user's
  // active tab is different).
  bufferedHost = host;
  await evaluateRewind();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (bufferedTabId === tabId || rewindCaptureActive?.tabId === tabId) {
    // The buffered tab is gone — the MediaStream's tracks have already
    // ended on the offscreen side (track-ended handler in rewind-buffer.ts)
    // but we mirror the teardown locally so evaluateRewind() doesn't try
    // to talk to the dead capture.
    bufferedTabId = null;
    bufferedHost = null;
    stopHeuristic();
    stopRewindEventCapture();
    chrome.runtime.sendMessage({ type: MSG.REWIND_STOP }).catch(() => {});
    // Phase 6: now re-evaluate against the new active tab. evaluateRewind()
    // will emit needsPopupOpen (no buffer + no gesture), idle (no active
    // tab), or fileBlocked/etc. as appropriate. A subsequent popup open
    // will reactivate via the popup-gesture path.
    evaluateRewind().catch(() => {});
  }
});

// When the user changes their rewind preferences (Phase 2 options page), the
// host lists or globallyEnabled flag may have changed — recompute.
onRewindPreferencesChanged(() => {
  evaluateRewind().catch(() => {});
});
