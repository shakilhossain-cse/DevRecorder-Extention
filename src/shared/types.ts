// ── Message Types ──────────────────────────
export const MSG = {
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  RECORDING_STATE: 'RECORDING_STATE',
  BEGIN_CAPTURE: 'BEGIN_CAPTURE',
  RECORDING_SAVED: 'RECORDING_SAVED',
  CONSOLE_EVENT: 'CONSOLE_EVENT',
  CAPTURE_READY: 'CAPTURE_READY',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  SELECT_REGION: 'SELECT_REGION',
  REGION_SELECTED: 'REGION_SELECTED',
  REGION_CANCELLED: 'REGION_CANCELLED',
  AUTH_TOKEN_RECEIVED: 'AUTH_TOKEN_RECEIVED',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
} as const;

// ── Capture Mode ───────────────────────────
export type CaptureMode = 'window' | 'region';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Event Types ────────────────────────────
export type EventType = 'console' | 'network' | 'navigation';

// ── Recording State ────────────────────────
export type RecordingStatus = 'idle' | 'recording' | 'stopping';

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

export interface TimelineEvent {
  _id?: string;
  recordingId: string;
  type: EventType;
  relativeTime: number;
  data: ConsoleEventData | NetworkEventData | NavigationEventData;
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
  | ConsoleEventMsg;
