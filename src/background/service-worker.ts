import { api } from '@shared/api';
import { MSG } from '@shared/types';
import type {
  RecordingState,
  ExtensionMessage,
  NetworkEventData,
  ConsoleEventData,
  CaptureMode,
  CropRect,
} from '@shared/types';

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
        if (recording.status === 'recording') {
          handleConsoleEvent(msg.data);
        }
        return false;

      case MSG.INTERACTION_EVENT:
        if (recording.status === 'recording') {
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

      default: {
        const raw = msg as any;
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
        if (raw.type === 'NETWORK_RESPONSE' && recording.status === 'recording') {
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
function onBeforeRequest(
  details: Parameters<Parameters<typeof chrome.webRequest.onBeforeRequest.addListener>[0]>[0]
): chrome.webRequest.BlockingResponse | undefined {
  if (details.tabId !== recording.tabId) return;
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
  if (details.tabId !== recording.tabId) return;
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
  if (details.tabId !== recording.tabId) return;
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
  if (details.tabId !== recording.tabId) return;
  const req = pendingRequests.get(details.requestId);
  if (!req) return;
  pendingRequests.delete(details.requestId);

  const relTime = req.startTime - recording.startTime!;
  const isXhr = req.type === 'xmlhttprequest';

  if (isXhr) {
    // XHR/fetch: delay to wait for page-agent's body interception
    const emitEvent = (retriesLeft: number) => {
      const bodies = findResponseBody(req.method, req.url);
      if (!bodies && retriesLeft > 0) {
        setTimeout(() => emitEvent(retriesLeft - 1), retriesLeft > 1 ? 1000 : 2000);
        return;
      }

      queueEvent('network', relTime, {
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
      } as unknown as Record<string, any>);
    };
    setTimeout(() => emitEvent(2), 500);
  } else {
    // Static resources (JS, CSS, images, fonts, etc.): emit immediately, no body needed
    queueEvent('network', relTime, {
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
    } as unknown as Record<string, any>);
  }
}

function onErrorOccurred(
  details: Parameters<Parameters<typeof chrome.webRequest.onErrorOccurred.addListener>[0]>[0]
) {
  if (details.tabId !== recording.tabId) return;
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

  queueEvent('network', req.startTime - recording.startTime!, data as unknown as Record<string, any>);
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
  if (details.tabId !== recording.tabId || details.frameId !== 0) return;
  queueEvent('navigation', details.timeStamp - recording.startTime!, {
    url: details.url,
    transitionType: details.transitionType,
  });
}

function onHistoryStateUpdated(
  details: chrome.webNavigation.WebNavigationTransitionCallbackDetails
): void {
  if (details.tabId !== recording.tabId || details.frameId !== 0) return;
  queueEvent('navigation', details.timeStamp - recording.startTime!, {
    url: details.url,
    transitionType: 'spa_navigation',
  });
}

// Re-inject content scripts and drawing overlay after page reload/navigation
function onNavCompleted(
  details: chrome.webNavigation.WebNavigationBaseCallbackDetails
): void {
  if (details.frameId !== 0) return;
  if (recording.status !== 'recording' && recording.status !== 'paused' && recording.status !== 'countdown') return;
  // Re-inject on the recording tab or any previously injected tab
  if (details.tabId !== recording.tabId && !injectedTabs.has(details.tabId)) return;

  // Content script (re-injects page-agent too)
  chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    files: ['content/content.js'],
  }).then(() => {
    // Activate page-agent after re-injection on navigation
    if (recording.status === 'recording') {
      chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        func: () => { window.postMessage({ source: 'devrecorder-control', action: 'start' }, '*'); },
      }).catch(() => {});
    }
  }).catch(() => {});

  // Drawing overlay (restores drawings from chrome.storage.session)
  chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    files: ['content/drawing-overlay.js'],
  }).catch(() => {});
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
  queueEvent('console', data.timestamp - recording.startTime!, {
    level: data.level as ConsoleEventData['level'],
    args: data.args,
    stack: data.stack || '',
  });
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
  queueEvent('interaction', data.timestamp - recording.startTime!, {
    action: data.action,
    selector: data.selector,
    tag: data.tag,
    text: data.text,
    attributes: data.attributes,
    attrCount: data.attrCount,
  });
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
