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

function queueEvent(type: string, relativeTime: number, data: Record<string, any>): void {
  if (!recording.id) return;
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
  api.sendEvents(recording.id, batch).catch(() => {});
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

      case MSG.PAUSE_RECORDING:
        if (recording.status === 'recording') {
          recording.status = 'paused';
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
          chrome.runtime.sendMessage({ type: MSG.RESUME_RECORDING }).catch(() => {});
          chrome.action.setBadgeText({ text: 'REC' });
          chrome.action.setBadgeBackgroundColor({ color: '#dc3232' });
          for (const tabId of injectedTabs) {
            chrome.tabs.sendMessage(tabId, { type: 'DEVRECORDER_RESUMED' }).catch(() => {});
          }
        }
        sendResponse({ success: true });
        return false;

      case MSG.REQUEST_MIC_PERMISSION:
        handleMicPermission().then(sendResponse);
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
  captureMode: CaptureMode = 'window',
): Promise<{ success: boolean; recordingId?: string; error?: string }> {
  if (recording.status !== 'idle') {
    return { success: false, error: 'Already recording' };
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

  // Window mode — start directly
  return beginRecording(tabId, tabTitle, tabUrl);
}

async function beginRecording(
  tabId: number,
  tabTitle: string,
  tabUrl: string,
  cropRect?: CropRect,
): Promise<{ success: boolean; recordingId?: string; error?: string }> {
  try {
    const now = Date.now();

    const rec = await api.createRecording({
      title: tabTitle || 'Untitled Recording',
      url: tabUrl || '',
      startTime: now,
      duration: 0,
    });

    await ensureOffscreenDocument();

    // Send BEGIN_CAPTURE and wait for user to grant screen permission
    await chrome.runtime.sendMessage({
      type: MSG.BEGIN_CAPTURE,
      recordingId: rec._id,
      cropRect,
    });

    // Wait for CAPTURE_READY or CAPTURE_FAILED from offscreen
    try {
      await new Promise<void>((resolve, reject) => {
        pendingCapture = { resolve, reject };
      });
    } catch (captureError) {
      // User cancelled the screen picker or capture failed — clean up
      api.deleteRecording(rec._id).catch(() => {});
      return { success: false, error: String(captureError) };
    }

    // User granted permission — now start recording
    const actualStart = Date.now();
    recording = {
      status: 'recording',
      id: rec._id,
      tabId,
      startTime: actualStart,
    };

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

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/drawing-overlay.js'],
      });
      injectedTabs.add(tabId);
    } catch {
      // Non-critical
    }

    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc3232' });
    startKeepalive();

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
  recording = { status: 'idle', id: null, tabId: null, startTime: null };
}

function removeOverlayFromAllTabs(): void {
  for (const tabId of injectedTabs) {
    chrome.tabs.sendMessage(tabId, { type: 'DEVRECORDER_REMOVE_DRAWING' }).catch(() => {});
  }
  injectedTabs.clear();
}

// ── Stop Recording ─────────────────────────────────────
async function stopRecording(): Promise<{
  success: boolean;
  recordingId?: string | null;
  error?: string;
}> {
  if (recording.status !== 'recording' && recording.status !== 'paused') {
    return { success: false, error: 'Not recording' };
  }

  recording.status = 'stopping';

  try {
    // Flush remaining events before stopping
    flushEvents();

    await chrome.runtime.sendMessage({ type: MSG.STOP_RECORDING });
    stopNetworkListeners();
    stopNavigationListeners();

    // Remove drawing overlay from all injected tabs
    removeOverlayFromAllTabs();

    // Keep keepalive running — offscreen is uploading the video
    // It will be stopped when RECORDING_SAVED is received
    chrome.action.setBadgeText({ text: 'UP' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });

    const recId = recording.id;
    recording = { status: 'uploading', id: recId, tabId: null, startTime: null };

    return { success: true, recordingId: recId };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function onRecordingSaved(recordingId: string, duration: number): void {
  api.updateRecording(recordingId, { duration }).catch(() => {});
  recording = { status: 'idle', id: null, tabId: null, startTime: null };
  chrome.action.setBadgeText({ text: '' });
  stopKeepalive();
  // Notify popup that upload is done (via storage so it works even if popup was reopened)
  chrome.storage.session.set({ uploadComplete: { recordingId, timestamp: Date.now() } });
}

// ── Offscreen Document ─────────────────────────────────
async function ensureOffscreenDocument(): Promise<void> {
  // Always close + recreate so getDisplayMedia works (it only fires once per doc)
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // No existing document — that's fine
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
  // Only capture fetch/XHR requests, skip images, scripts, CSS, fonts etc.
  if (details.type !== 'xmlhttprequest') return;

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

  // Delay slightly so page-agent's fetch/XHR interceptor has time to send response body
  setTimeout(() => {
    const bodyKey = `${req.method}:${req.url}`;
    const bodies = responseBodyBuffer.get(bodyKey);
    if (bodies) responseBodyBuffer.delete(bodyKey);

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

    queueEvent('network', relTime, data as unknown as Record<string, any>);
  }, 500);
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

function startNavigationListeners(): void {
  chrome.webNavigation.onCommitted.addListener(onNavCommitted);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onHistoryStateUpdated);
}

function stopNavigationListeners(): void {
  chrome.webNavigation.onCommitted.removeListener(onNavCommitted);
  chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistoryStateUpdated);
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

// ── Network Response Handler (from page-agent fetch/XHR intercept) ──
// Buffer response bodies keyed by url+method+status, merged into queued events
const responseBodyBuffer = new Map<string, { requestBody: string | null; responseBody: string | null }>();

function handleNetworkResponse(data: {
  url: string;
  method: string;
  status: number;
  requestBody: string | null;
  responseBody: string | null;
  timestamp: number;
}): void {
  // Store in buffer — will be picked up by onCompleted network handler
  const key = `${data.method}:${data.url}`;
  responseBodyBuffer.set(key, {
    requestBody: data.requestBody,
    responseBody: data.responseBody,
  });
  // Clean old entries after 10s
  setTimeout(() => responseBodyBuffer.delete(key), 10000);
}

// ── Tab Switch: inject drawing overlay on every active tab ──
const injectedTabs = new Set<number>();

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (recording.status !== 'recording') return;

  const newTabId = activeInfo.tabId;

  // Update tracked tab — only this tab's events go to DB
  recording.tabId = newTabId;

  // Inject overlay into new tab (restores drawings from storage)
  // Don't remove from old tab — drawings persist there too
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
});

// ── Tab Close Handler ──────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  if (recording.status === 'recording' && recording.tabId === tabId) {
    stopRecording();
  }
});

// ── Mic Permission via popup window ────────────────────
let micPermissionResolve: ((result: { granted: boolean; error?: string }) => void) | null = null;

async function handleMicPermission(): Promise<{ granted: boolean; error?: string }> {
  return new Promise((resolve) => {
    micPermissionResolve = resolve;
    // Open a small window so Chrome can show the mic permission prompt
    chrome.windows.create({
      url: chrome.runtime.getURL('mic-permission.html'),
      type: 'popup',
      width: 380,
      height: 240,
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

// ── Service Worker Keepalive ───────────────────────────
function startKeepalive(): void {
  chrome.alarms.create('devrecorder-keepalive', { periodInMinutes: 0.4 });
}

function stopKeepalive(): void {
  chrome.alarms.clear('devrecorder-keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'devrecorder-keepalive' && recording.status === 'recording') {
    // Keeps the service worker alive
  }
});
