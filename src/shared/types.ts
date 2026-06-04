// ── Message Types ──────────────────────────
export const MSG = {
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  RECORDING_STATE: 'RECORDING_STATE',
  BEGIN_CAPTURE: 'BEGIN_CAPTURE',
  BEGIN_TAB_CAPTURE: 'BEGIN_TAB_CAPTURE',
  RECORDING_SAVED: 'RECORDING_SAVED',
  CONSOLE_EVENT: 'CONSOLE_EVENT',
  CAPTURE_READY: 'CAPTURE_READY',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  SELECT_REGION: 'SELECT_REGION',
  REGION_SELECTED: 'REGION_SELECTED',
  REGION_CANCELLED: 'REGION_CANCELLED',
  AUTH_TOKEN_RECEIVED: 'AUTH_TOKEN_RECEIVED',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  REQUEST_MIC_PERMISSION: 'REQUEST_MIC_PERMISSION',
  PAUSE_RECORDING: 'PAUSE_RECORDING',
  RESUME_RECORDING: 'RESUME_RECORDING',
  COUNTDOWN_COMPLETE: 'COUNTDOWN_COMPLETE',
  INTERACTION_EVENT: 'INTERACTION_EVENT',
  TAKE_SCREENSHOT: 'TAKE_SCREENSHOT',
  SCREENSHOT_SAVED: 'SCREENSHOT_SAVED',
  SCREENSHOT_SAVE: 'SCREENSHOT_SAVE',
  // ── Share Last Minute / Rewind (Phase 1) ──
  REWIND_START: 'REWIND_START',
  REWIND_STOP: 'REWIND_STOP',
  REWIND_FINALIZE: 'REWIND_FINALIZE',
  REWIND_STATUS: 'REWIND_STATUS',
  REWIND_STATUS_CHANGED: 'REWIND_STATUS_CHANGED',
  SHARE_LAST_MINUTE: 'SHARE_LAST_MINUTE',
  FORCE_ENABLE_REWIND: 'FORCE_ENABLE_REWIND',
  UPDATE_REWIND_BLOCKLIST: 'UPDATE_REWIND_BLOCKLIST',
  // Phase 6 — popup -> SW. Asks the SW to move the rolling buffer onto the
  // tab the popup is currently looking at. Carries the popup's user-gesture
  // context so getMediaStreamId can succeed.
  REWIND_SWITCH_TAB: 'REWIND_SWITCH_TAB',
  // Phase 6 — SW -> offscreen and back. The SW uses this on its boot path to
  // discover whether an offscreen-held buffer survived a service-worker
  // restart (Chrome keeps the offscreen doc alive while it holds a USER_MEDIA
  // stream). Returns the tabId being captured + a buffer-active flag.
  REWIND_BUFFER_INFO: 'REWIND_BUFFER_INFO',
  // Phase 3 — broadcast by the SW once a Share Last Minute clip is persisted
  // to IndexedDB. The popup uses this to swap its notice copy and self-close.
  REWIND_CLIP_SAVED: 'REWIND_CLIP_SAVED',
  REWIND_CLIP_SAVE_FAILED: 'REWIND_CLIP_SAVE_FAILED',
} as const;

// ── Capture Mode ───────────────────────────
export type CaptureMode = 'tab' | 'desktop' | 'region';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Event Types ────────────────────────────
export type EventType = 'console' | 'network' | 'navigation' | 'device-info' | 'storage' | 'interaction' | 'screenshot';

// ── Recording State ────────────────────────
export type RecordingStatus = 'idle' | 'countdown' | 'recording' | 'paused' | 'stopping' | 'uploading';

export interface RecordingState {
  status: RecordingStatus;
  id: string | null;
  tabId: number | null;
  startTime: number | null;
}

// ── DB Models ──────────────────────────────
export interface Recording {
  _id: string;
  title: string;
  url: string;
  startTime: number;
  duration: number;
  videoKey?: string;
  videoUrl?: string;
  createdAt: string;
}

export interface ConsoleEventData {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  args: string[];
  stack: string;
}

export interface NetworkEventData {
  url: string;
  method: string;
  resourceType: string;
  status: number;
  statusLine: string;
  duration: number;
  initiator: string;
  error: string | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: string | null;
  responseBody: string | null;
}

export interface NavigationEventData {
  url: string;
  transitionType: string;
}

export interface InteractionEventData {
  action: 'click' | 'input' | 'scroll' | 'focus';
  selector: string;
  tag: string;
  text?: string;
  attributes: Record<string, string>;
  attrCount: number;
}

export interface TimelineEvent {
  _id?: string;
  recordingId: string;
  type: EventType;
  relativeTime: number;
  data: ConsoleEventData | NetworkEventData | NavigationEventData | InteractionEventData;
}

// ── Messages ───────────────────────────────
export interface StartRecordingMsg {
  type: typeof MSG.START_RECORDING;
  tabId: number;
  tabTitle: string;
  tabUrl: string;
  captureMode: CaptureMode;
}

export interface StopRecordingMsg {
  type: typeof MSG.STOP_RECORDING;
}

export interface RecordingStateMsg {
  type: typeof MSG.RECORDING_STATE;
}

export interface BeginCaptureMsg {
  type: typeof MSG.BEGIN_CAPTURE;
  recordingId: string;
  cropRect?: CropRect;
}

export interface RecordingSavedMsg {
  type: typeof MSG.RECORDING_SAVED;
  recordingId: string;
  duration: number;
}

export interface CaptureReadyMsg {
  type: typeof MSG.CAPTURE_READY;
}

export interface CaptureFailedMsg {
  type: typeof MSG.CAPTURE_FAILED;
  error: string;
}

export interface SelectRegionMsg {
  type: typeof MSG.SELECT_REGION;
}

export interface RegionSelectedMsg {
  type: typeof MSG.REGION_SELECTED;
  rect: CropRect;
}

export interface RegionCancelledMsg {
  type: typeof MSG.REGION_CANCELLED;
}

export interface ConsoleEventMsg {
  type: typeof MSG.CONSOLE_EVENT;
  data: {
    level: string;
    args: string[];
    timestamp: number;
    stack: string;
  };
}

export interface RequestMicPermissionMsg {
  type: typeof MSG.REQUEST_MIC_PERMISSION;
}

export interface PauseRecordingMsg {
  type: typeof MSG.PAUSE_RECORDING;
}

export interface ResumeRecordingMsg {
  type: typeof MSG.RESUME_RECORDING;
}

export interface CountdownCompleteMsg {
  type: typeof MSG.COUNTDOWN_COMPLETE;
}

export interface InteractionEventMsg {
  type: typeof MSG.INTERACTION_EVENT;
  data: {
    action: 'click' | 'input' | 'scroll' | 'focus';
    selector: string;
    tag: string;
    text?: string;
    attributes: Record<string, string>;
    attrCount: number;
    timestamp: number;
  };
}

export interface TakeScreenshotMsg {
  type: typeof MSG.TAKE_SCREENSHOT;
  tabId: number;
  tabTitle: string;
  tabUrl: string;
  delay?: number;
}

export interface ScreenshotSaveMsg {
  type: typeof MSG.SCREENSHOT_SAVE;
  recordingId: string;
  imageDataUrl: string;
}

export interface ScreenshotSavedMsg {
  type: typeof MSG.SCREENSHOT_SAVED;
  recordingId: string;
}

// ── Share Last Minute / Rewind (Phase 2 + Phase 6) ────
// Full state machine describing why the rolling buffer is or isn't running on
// the user's currently-active tab. The popup branches on `status` to render
// the right tooltip, disabled/enabled visual, and click handler.
//
// Phase 6 note: once bootstrapped, the rolling buffer runs continuously on
// whichever tab it was started on (matching jam.dev's persistent-buffer UX).
// Tab switches no longer tear down the buffer; instead they surface as
// `enabledOnOtherTab` whenever the user-active tab is different from the
// buffered tab. The popup can then offer to switch capture to the active tab
// (carrying its user gesture to satisfy getMediaStreamId).
//
//   - enabled            : actively buffering on this (user-active) tab
//   - forceEnabled       : auto-disabled by the heuristic, user re-enabled it
//   - enabledOnOtherTab  : buffer is alive on `bufferedTabId`, user is now
//                          looking at a different tab (`activeHost`)
//   - autoDisabled       : heuristic flipped it off due to sustained pressure
//   - urlBlocked         : site is on the user's blocklist
//   - defaultBlocked     : site is on the built-in privacy blocklist
//   - fileBlocked        : current tab is a file:// URL (tabCapture cannot)
//   - fullyDisabled      : user toggled the feature off globally
//   - browserInternal    : chrome://, edge://, about:, devtools:, web store, etc.
//   - needsPopupOpen     : tabCapture needs a user gesture; opening the popup
//                          kicks it (no buffer is alive anywhere)
//   - idle               : no active tab / transient bootstrap state
export type RewindStatus =
  | { status: 'enabled' }
  | { status: 'forceEnabled'; host: string }
  | {
      status: 'enabledOnOtherTab';
      bufferedHost: string;
      bufferedTabId: number;
      activeHost: string;
    }
  | { status: 'autoDisabled'; host: string }
  | { status: 'urlBlocked'; host: string }
  | { status: 'defaultBlocked'; host: string }
  | { status: 'fileBlocked' }
  | { status: 'fullyDisabled' }
  | { status: 'browserInternal' }
  | { status: 'needsPopupOpen' }
  | { status: 'idle' };

export interface RewindPreferences {
  globallyEnabled: boolean;       // default true
  bufferSeconds: number;          // default 60
  blockedHosts: string[];         // Phase 2: user blocklist
  forceEnabledHosts: string[];    // Phase 2: user override against auto-disable
  autoDisabledHosts: string[];    // Phase 2: heuristic auto-disable
}

export interface RewindStartMsg {
  type: typeof MSG.REWIND_START;
  streamId: string;
  bufferSeconds: number;
  // Phase 6: the tab whose stream is being captured. Persisted in the
  // offscreen module so the SW can re-discover which tab a survived buffer
  // belongs to after a service-worker restart.
  tabId: number;
  // Phase 6: host string the SW had resolved for the tab at start time.
  // Threaded through so the buffer can report it back via REWIND_BUFFER_INFO
  // without having to re-query the tabs API from the offscreen doc.
  host: string;
}

export interface RewindStopMsg {
  type: typeof MSG.REWIND_STOP;
}

export interface RewindFinalizeMsg {
  type: typeof MSG.REWIND_FINALIZE;
}

export interface RewindStatusMsg {
  type: typeof MSG.REWIND_STATUS;
}

// Legacy shape still emitted by the offscreen buffer (see
// src/offscreen/rewind-buffer.ts). The SW translates it into the new state
// machine on receipt; keeping it in the message union here lets the offscreen
// file continue to compile during Phase 2 without changes.
export type LegacyOffscreenRewindStatus =
  | { status: 'enabled' }
  | { status: 'disabled'; reason: string };

export interface RewindStatusChangedMsg {
  type: typeof MSG.REWIND_STATUS_CHANGED;
  status: RewindStatus | LegacyOffscreenRewindStatus;
}

export interface ShareLastMinuteMsg {
  type: typeof MSG.SHARE_LAST_MINUTE;
}

// Phase 2 — popup -> SW. The user opted back in to rewind on a site that the
// heuristic had auto-disabled (or wants to override a future auto-disable on
// this host). The SW adds the host to forceEnabledHosts, removes it from
// autoDisabledHosts, and re-evaluates.
export interface ForceEnableRewindMsg {
  type: typeof MSG.FORCE_ENABLE_REWIND;
  host: string;
}

// Phase 2 — popup -> SW. Toggle a host on/off the user blocklist. When adding,
// any matching entry in forceEnabledHosts is dropped (an explicit block trumps
// a prior override).
export interface UpdateRewindBlocklistMsg {
  type: typeof MSG.UPDATE_REWIND_BLOCKLIST;
  action: 'add' | 'remove';
  host: string;
}

// Phase 6 — popup -> SW. The user wants to switch the rolling buffer to the
// tab they're currently on (which they confirmed via clicking the rewind
// button while it showed `enabledOnOtherTab`). The popup-message context
// carries the user gesture needed for getMediaStreamId on the target tab.
export interface RewindSwitchTabMsg {
  type: typeof MSG.REWIND_SWITCH_TAB;
  targetTabId: number;
}

// Phase 6 — SW <-> offscreen. The SW boot path uses this to ask whether a
// rolling buffer is already alive from a previous service-worker lifetime
// (Chrome keeps the offscreen doc alive while it holds a USER_MEDIA stream).
// The offscreen responds with the current buffer's tabId + host, or with
// `active: false` if no buffer is running.
export interface RewindBufferInfoMsg {
  type: typeof MSG.REWIND_BUFFER_INFO;
}

export interface RewindBufferInfoResponse {
  active: boolean;
  tabId: number | null;
  host: string | null;
  bufferSeconds: number;
}

// Phase 3 — SW -> popup. Confirms that a Share Last Minute click resulted in a
// clip being persisted to IndexedDB; carries the new clip id so the popup can
// surface the right notice / link if needed. The viewer is opened by the SW
// in parallel, so the popup typically just self-closes on receipt.
export interface RewindClipSavedMsg {
  type: typeof MSG.REWIND_CLIP_SAVED;
  clipId: string;
  durationMs: number;
  sizeBytes: number;
}

// Phase 3 — SW -> popup. Signals that the save flow failed after the user's
// click. Surfaces a human-readable reason for the inline notice.
export interface RewindClipSaveFailedMsg {
  type: typeof MSG.REWIND_CLIP_SAVE_FAILED;
  error: string;
}

export type ExtensionMessage =
  | StartRecordingMsg
  | StopRecordingMsg
  | RecordingStateMsg
  | BeginCaptureMsg
  | RecordingSavedMsg
  | CaptureReadyMsg
  | CaptureFailedMsg
  | SelectRegionMsg
  | RegionSelectedMsg
  | RegionCancelledMsg
  | ConsoleEventMsg
  | RequestMicPermissionMsg
  | PauseRecordingMsg
  | ResumeRecordingMsg
  | CountdownCompleteMsg
  | InteractionEventMsg
  | TakeScreenshotMsg
  | ScreenshotSaveMsg
  | ScreenshotSavedMsg
  | RewindStartMsg
  | RewindStopMsg
  | RewindFinalizeMsg
  | RewindStatusMsg
  | RewindStatusChangedMsg
  | ShareLastMinuteMsg
  | ForceEnableRewindMsg
  | UpdateRewindBlocklistMsg
  | RewindSwitchTabMsg
  | RewindBufferInfoMsg
  | RewindClipSavedMsg
  | RewindClipSaveFailedMsg;
