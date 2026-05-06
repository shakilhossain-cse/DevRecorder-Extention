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
const MAX_BUFFER_SIZE = 500;

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

    // Activate page-agent on this tab (it starts inactive to avoid perf overhead)
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { window.postMessage({ source: 'devrecorder-control', action: 'start' }, '*'); },
      });
    } catch { /* non-critical */ }

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
  // Clear event buffer
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  eventBuffer = [];
  recording = { status: 'idle', id: null, tabId: null, startTime: null };
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
  if (recording.status !== 'recording' && recording.status !== 'paused') {
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

  // Evict stale pending requests older than 60s (e.g. aborted/hung requests)
  if (pendingRequests.size > 200) {
    const cutoff = details.timeStamp - 60_000;
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

  // Delay so page-agent's fetch/XHR interceptor has time to send response body.
  // Try at 500ms first, retry at 1.5s, then final attempt at 3.5s.
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

    queueEvent('network', relTime, data as unknown as Record<string, any>);
  };

  setTimeout(() => emitEvent(2), 500);
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
  if (recording.status !== 'recording' && recording.status !== 'paused') return;
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
const MAX_RESPONSE_BUFFER = 500;

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
  const STALE_MS = 30_000;
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
  if (recording.status === 'recording' && recording.tabId === tabId) {
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
