# DevRecorder — Chrome Extension

A screen recorder Chrome extension built for developer debugging. Records screen video alongside console logs, network requests (headers, payloads, responses), and page navigations — all synchronized on a timeline.

**Website:** https://www.devrecorder.com
**Manifest Version:** 3
**Stack:** TypeScript, React 19, Vite 8, Chrome Extensions API

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Project Structure](#project-structure)
- [Complete Data Flow](#complete-data-flow)
- [Component Deep Dive](#component-deep-dive)
  - [Popup (UI)](#1-popup-ui)
  - [Service Worker (Background)](#2-service-worker-background)
  - [Content Script](#3-content-script)
  - [Page Agent](#4-page-agent)
  - [Offscreen Document](#5-offscreen-document)
  - [Drawing Overlay](#6-drawing-overlay)
  - [Region Selector](#7-region-selector)
  - [Viewer](#8-viewer)
  - [Auth Detector](#9-auth-detector)
  - [Mic Permission](#10-mic-permission)
- [Message Protocol](#message-protocol)
- [Network Capture Pipeline](#network-capture-pipeline)
- [Video Recording Pipeline](#video-recording-pipeline)
- [Security & Privacy](#security--privacy)
- [Permissions](#permissions)
- [Build & Development](#build--development)
- [API Endpoints](#api-endpoints)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Chrome Browser                               │
│                                                                     │
│  ┌──────────┐    ┌──────────────────┐    ┌───────────────────────┐  │
│  │  Popup   │───>│  Service Worker   │<──>│  Offscreen Document   │  │
│  │ (React)  │    │  (Background)     │    │  (MediaRecorder)      │  │
│  └──────────┘    └────────┬─────────┘    └───────────────────────┘  │
│                           │                                         │
│                           │ chrome.scripting                        │
│                           │ chrome.webRequest                       │
│                           │ chrome.webNavigation                    │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Active Tab                                │    │
│  │  ┌───────────────┐    ┌──────────────┐    ┌──────────────┐  │    │
│  │  │ Content Script │───>│  Page Agent   │    │   Drawing    │  │    │
│  │  │ (message relay)│<───│ (fetch/XHR/  │    │   Overlay    │  │    │
│  │  │               │    │  console)     │    │  (canvas)    │  │    │
│  │  └───────────────┘    └──────────────┘    └──────────────┘  │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│                           │                                         │
│                           ▼                                         │
│                  ┌─────────────────┐                                │
│                  │  DevRecorder API │                                │
│                  │  (Backend)       │                                │
│                  │  + R2 Storage    │                                │
│                  └─────────────────┘                                │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Viewer Page (React)                                         │   │
│  │  Video player + synchronized event timeline                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
extension/
├── public/
│   ├── manifest.json          # MV3 manifest
│   ├── mic-permission.html    # Mic permission prompt popup
│   └── icons/                 # Extension icons (16/48/128)
├── src/
│   ├── background/
│   │   └── service-worker.ts  # Core orchestrator — state, webRequest, events
│   ├── content/
│   │   ├── content.ts         # Message relay between page-agent and service worker
│   │   ├── page-agent.ts      # Injected into page — intercepts fetch/XHR/console
│   │   ├── drawing-overlay.ts # Annotation canvas + recording control bar
│   │   ├── region-selector.ts # Drag-to-select screen region
│   │   └── auth-detector.ts   # Picks up auth token from devrecorder.com
│   ├── offscreen/
│   │   ├── offscreen.ts       # MediaRecorder — captures & uploads video
│   │   └── fix-webm-duration.ts # Patches WebM duration metadata for seeking
│   ├── popup/
│   │   ├── main.tsx           # Popup entry point
│   │   ├── Popup.tsx          # Popup UI — start/stop/pause, mode select, mic toggle
│   │   └── popup.css          # Popup styles
│   ├── viewer/
│   │   ├── main.tsx           # Viewer entry point
│   │   ├── Viewer.tsx         # Recording list + playback router
│   │   ├── RecordingList.tsx  # Grid of saved recordings
│   │   ├── Playback.tsx       # Video player + event timeline
│   │   ├── EventRow.tsx       # Single event row (console/network/navigation)
│   │   ├── NetworkDetail.tsx  # Network request detail panel (headers/payload/response)
│   │   └── utils.ts           # Time/date formatting helpers
│   ├── shared/
│   │   ├── types.ts           # All TypeScript interfaces & message types
│   │   ├── api.ts             # API client — CRUD recordings, upload video, send events
│   │   └── ErrorBoundary.tsx  # React error boundary
│   └── mic-permission.ts     # Mic permission popup script
├── popup.html                 # Popup HTML shell
├── viewer.html                # Viewer HTML shell
├── offscreen.html             # Offscreen document HTML shell
├── vite.config.ts             # Build config — main build + IIFE content scripts
├── tsconfig.json              # TypeScript config
└── package.json               # Dependencies & scripts
```

---

## Complete Data Flow

### 1. Authentication

```
User clicks "Sign in" in popup
  → Opens https://www.devrecorder.com/extension-auth
  → User signs in with Google
  → Page renders <div id="devrecorder-token" data-token="...">
  → auth-detector.ts (content script) reads the token
  → Sends AUTH_TOKEN_RECEIVED to service worker
  → Service worker stores token in chrome.storage.local
  → Popup detects token via storage.onChanged → shows main UI
```

### 2. Start Recording

```
User clicks "Start Recording" in popup
  │
  ├─[Window mode]──────────────────────────────────────────────────┐
  │  Popup sends START_RECORDING {tabId, tabTitle, tabUrl}         │
  │  → Service worker calls api.createRecording()                  │
  │  → Creates offscreen document                                  │
  │  → Sends BEGIN_CAPTURE to offscreen                            │
  │  → Offscreen calls getDisplayMedia() → user picks window       │
  │  → Offscreen sends CAPTURE_READY                               │
  │  → Service worker starts:                                      │
  │     • webRequest listeners (network)                           │
  │     • webNavigation listeners (navigation)                     │
  │     • Injects content.js → injects page-agent.js               │
  │     • Sends 'start' activation to page-agent                   │
  │     • Injects drawing-overlay.js                               │
  │     • Starts keepalive alarm (every 24s)                       │
  │                                                                │
  ├─[Region mode]──────────────────────────────────────────────────┐
  │  Same as above but first:                                      │
  │  → Injects region-selector.js                                  │
  │  → User drags to select region                                 │
  │  → Sends REGION_SELECTED {rect}                                │
  │  → Offscreen crops video via canvas at 30fps                   │
  └────────────────────────────────────────────────────────────────┘
```

### 3. During Recording

```
┌─ VIDEO ──────────────────────────────────────────────────────────┐
│ Offscreen: MediaRecorder captures stream at 2.5Mbps             │
│ → ondataavailable fires every 1s → chunks[] array               │
│ → Every 30s: chunks consolidated into single Blob               │
│ → Audio: system audio + optional mic mixed via AudioContext      │
└──────────────────────────────────────────────────────────────────┘

┌─ NETWORK ────────────────────────────────────────────────────────┐
│ Layer 1: chrome.webRequest (service worker)                      │
│   onBeforeRequest  → capture request body, create pending entry  │
│   onSendHeaders    → capture request headers                     │
│   onHeadersReceived → capture response headers                   │
│   onCompleted      → finalize with status, duration              │
│                                                                  │
│ Layer 2: Page Agent (injected script in page context)            │
│   Monkey-patches window.fetch and XMLHttpRequest                 │
│   → Clones response, reads body text                             │
│   → Posts to content script via window.postMessage               │
│   → Content script forwards to service worker                    │
│                                                                  │
│ Matching: service worker waits 500ms–3.5s for page-agent         │
│ response body to arrive, matches by method + URL                 │
│                                                                  │
│ Final NetworkEventData:                                          │
│ {url, method, status, statusLine, duration, initiator,           │
│  requestHeaders, responseHeaders, requestBody, responseBody}     │
└──────────────────────────────────────────────────────────────────┘

┌─ CONSOLE ────────────────────────────────────────────────────────┐
│ Page Agent overrides console.log/warn/error/info/debug           │
│ → Serializes args (JSON.stringify, capped at 10KB)               │
│ → Posts to content script → service worker                       │
│ Also captures: window 'error' + 'unhandledrejection' events     │
└──────────────────────────────────────────────────────────────────┘

┌─ NAVIGATION ─────────────────────────────────────────────────────┐
│ chrome.webNavigation.onCommitted → full navigations              │
│ chrome.webNavigation.onHistoryStateUpdated → SPA navigations     │
│ After navigation: re-injects content.js + drawing-overlay.js     │
│                   + re-activates page-agent                      │
└──────────────────────────────────────────────────────────────────┘

┌─ EVENT BUFFERING ────────────────────────────────────────────────┐
│ All events → queueEvent(type, relativeTime, data)                │
│ → eventBuffer[] (max 500 entries, FIFO eviction)                 │
│ → Flushed to API every 2s via api.sendEvents()                   │
│ → POST /api/recordings/events/bulk {recordingId, events[]}       │
└──────────────────────────────────────────────────────────────────┘

┌─ ANNOTATIONS ────────────────────────────────────────────────────┐
│ Drawing overlay: full-screen canvas with tools                   │
│ Tools: pen, line, arrow, circle, rectangle, square, text, blur   │
│ Colors: 6 presets, adjustable width, blur opacity                │
│ Canvas state saved to chrome.storage.session (per tab, max 2MB)  │
│ Survives page reloads within the recording session               │
└──────────────────────────────────────────────────────────────────┘
```

### 4. Tab Switching During Recording

```
User switches to a different tab
  → chrome.tabs.onActivated fires
  → recording.tabId updated to new tab
  → Content script + drawing overlay injected if not already
  → Page-agent activated with 'start' command
  → webRequest listeners now filter for the new tabId
```

### 5. Pause / Resume

```
Pause: popup or control bar sends PAUSE_RECORDING
  → Service worker sets status = 'paused'
  → Offscreen: mediaRecorder.pause()
  → All injected tabs notified (control bar updates)

Resume: popup or control bar sends RESUME_RECORDING
  → Service worker sets status = 'recording'
  → Offscreen: mediaRecorder.resume()
  → Page-agent re-activated on all tabs
```

### 6. Stop Recording & Upload

```
User clicks Stop
  → Service worker flushes remaining events
  → Deactivates page-agent, removes drawing overlays
  → Sends STOP_RECORDING to offscreen
  → Offscreen: mediaRecorder.stop()
    → onstop handler:
      1. Merges consolidated blob + remaining chunks
      2. fixWebmDuration() patches binary WebM for seeking support
      3. Upload to R2:
         - <10MB: single presigned PUT
         - >10MB: multipart upload (10MB chunks, 3 retries each)
      4. Sends RECORDING_SAVED {recordingId, duration}
  → Service worker: updates recording duration via API
  → Popup shows share link
```

### 7. Viewing Recordings

```
User opens viewer (devrecorder.com or extension viewer page)
  → Fetches recording list from API
  → Selects a recording → loads video + events
  → Playback.tsx:
    - Video player with <video> element (source: R2 URL)
    - Event timeline synced to video currentTime
    - Filter by: All / Console / Network / Navigation
    - Click network event → NetworkDetail panel
      - Headers tab: general info, query params, request/response headers
      - Payload tab: request body (formatted JSON)
      - Response tab: response body (formatted JSON)
    - Click console/navigation event → seeks video to that time
    - Auto-scroll follows playback (pauses on manual scroll, resumes after 10s)
```

---

## Component Deep Dive

### 1. Popup (UI)
**Files:** `src/popup/Popup.tsx`, `src/popup/main.tsx`

The browser action popup. React SPA rendered in the extension popup window.

**States:** Loading → Login → Ready → Recording → Paused → Uploading → Saved
**Features:**
- Google sign-in (redirects to devrecorder.com/extension-auth)
- Window / Region capture mode toggle
- Microphone enable/disable
- Start / Pause / Resume / Stop controls
- Timer display
- Upload progress bar
- Share link with copy button
- Dark/light theme toggle
- Sign out

### 2. Service Worker (Background)
**File:** `src/background/service-worker.ts`

The central orchestrator. Runs as a MV3 service worker.

**Responsibilities:**
- Recording state machine (idle → recording → paused → stopping → uploading → idle)
- Message routing between popup, offscreen, content scripts
- chrome.webRequest listeners for network capture (headers, request body)
- chrome.webNavigation listeners for navigation events
- Event buffering and batched API flush (every 2s, max 500 events)
- Tab switch handling (re-injection, page-agent activation)
- Keepalive alarm to prevent service worker termination
- Sensitive header redaction (authorization, cookies, API keys, etc.)

### 3. Content Script
**File:** `src/content/content.ts`

Lightweight message relay. Injected at `document_start` on all pages (via manifest).

**Responsibilities:**
- Injects page-agent.js into the page's main world (via `<script>` tag)
- Forwards page-agent messages (console, network-response) to service worker via `chrome.runtime.sendMessage`
- Checks recording state on injection — activates page-agent if recording is in progress

### 4. Page Agent
**File:** `src/content/page-agent.ts`

Injected into the page's main world (not the content script isolated world). This is necessary to intercept the page's own `fetch` and `XMLHttpRequest` calls.

**Responsibilities:**
- Monkey-patches `window.fetch` and `XMLHttpRequest.prototype.open/send`
- Captures response bodies by cloning responses
- Captures request bodies from fetch init/XHR send
- Overrides `console.log/warn/error/info/debug` to capture logs
- Listens for `window.error` and `unhandledrejection` events
- Redacts sensitive fields in request/response bodies (password, token, api_key, etc.)
- Controlled by `active` flag — does zero work when not recording

**Content-type filtering:** Only captures text-based responses (json, text, xml, html, javascript, form-urlencoded, or empty content-type). Binary responses are skipped.

**Size limits:** Response bodies capped at 500KB. Console args capped at 10KB.

### 5. Offscreen Document
**Files:** `src/offscreen/offscreen.ts`, `src/offscreen/fix-webm-duration.ts`

Chrome MV3 requires an offscreen document for `getDisplayMedia`. This document handles all video recording.

**Responsibilities:**
- Calls `navigator.mediaDevices.getDisplayMedia()` to get screen capture stream
- Optionally captures microphone via `getUserMedia()`
- Mixes system audio + mic audio via `AudioContext`
- Region mode: renders video frames to canvas at 30fps, captures canvas stream
- Records via `MediaRecorder` (WebM VP9/VP8 + Opus, 2.5Mbps)
- Consolidates blob chunks every 30s to reduce memory fragmentation
- On stop: patches WebM duration metadata for seeking support
- Uploads to R2 (simple PUT for <10MB, multipart for >10MB)

**fix-webm-duration.ts:** Chrome's MediaRecorder produces WebM files without duration metadata, making seeking impossible. This module parses the EBML binary format and injects the correct duration into the Segment > Info > Duration element.

### 6. Drawing Overlay
**File:** `src/content/drawing-overlay.ts`

Full-screen annotation canvas injected into the recording tab.

**Features:**
- Recording control bar (timer, pause/resume, stop, annotate)
- 8 drawing tools: pen, line, arrow, circle, rectangle, square, text, blur
- 6 color presets, adjustable stroke width, blur opacity
- Canvas state persisted to `chrome.storage.session` (survives page reloads)
- Per-tab canvas storage (drawings don't bleed across tabs)
- Clean teardown on recording stop

### 7. Region Selector
**File:** `src/content/region-selector.ts`

Overlay for selecting a screen region to record.

- Full-screen semi-transparent overlay with crosshair cursor
- Drag to select region (shows selection box + dimension label)
- Sends `REGION_SELECTED` with DPR-scaled coordinates
- Escape to cancel
- Shows dashed border during recording to indicate captured region

### 8. Viewer
**Files:** `src/viewer/Viewer.tsx`, `Playback.tsx`, `RecordingList.tsx`, `EventRow.tsx`, `NetworkDetail.tsx`

React SPA for browsing and playing back recordings.

- **RecordingList:** Grid of recording cards with title, duration, date, share, delete
- **Playback:** Split-panel layout — video player (left) + event timeline (right)
- **EventRow:** Renders console (log level badge + message), network (method badge + URL + status + duration), or navigation (NAV badge + URL + transition type)
- **NetworkDetail:** Tabbed panel with Headers (general info, query params, request/response headers), Payload (request body), Response (response body)
- Auto-scroll syncs event list to video playback position

### 9. Auth Detector
**File:** `src/content/auth-detector.ts`

Tiny content script that runs only on `https://www.devrecorder.com/extension-auth*`. Reads the API token from a DOM element and sends it to the service worker.

### 10. Mic Permission
**File:** `src/mic-permission.ts`

Script for a small popup window that requests microphone permission via `getUserMedia()`. Chrome requires user gesture context for mic permission — the service worker opens this popup, which requests permission and reports back.

---

## Message Protocol

All inter-component communication uses `chrome.runtime.sendMessage` (extension messaging) and `window.postMessage` (page ↔ content script).

| Message | From | To | Purpose |
|---|---|---|---|
| `START_RECORDING` | Popup | Service Worker | Begin recording flow |
| `STOP_RECORDING` | Popup/Overlay | Service Worker + Offscreen | Stop recording |
| `RECORDING_STATE` | Any | Service Worker | Query current state |
| `BEGIN_CAPTURE` | Service Worker | Offscreen | Start getDisplayMedia |
| `CAPTURE_READY` | Offscreen | Service Worker | User granted screen permission |
| `CAPTURE_FAILED` | Offscreen | Service Worker | User cancelled/error |
| `RECORDING_SAVED` | Offscreen | Service Worker | Upload complete |
| `PAUSE_RECORDING` | Popup/Overlay | Service Worker + Offscreen | Pause |
| `RESUME_RECORDING` | Popup/Overlay | Service Worker + Offscreen | Resume |
| `REGION_SELECTED` | Region Selector | Service Worker | Region coordinates |
| `REGION_CANCELLED` | Region Selector | Service Worker | User cancelled selection |
| `CONSOLE_EVENT` | Content Script | Service Worker | Console log/error |
| `NETWORK_RESPONSE` | Content Script | Service Worker | Response body from page-agent |
| `AUTH_TOKEN_RECEIVED` | Auth Detector | Service Worker | Store API token |
| `REQUEST_MIC_PERMISSION` | Popup | Service Worker | Open mic permission window |
| `MIC_PERMISSION_RESULT` | Mic Permission | Service Worker | Permission granted/denied |
| `DEVRECORDER_PAUSED` | Service Worker | Content Script | Notify tabs of pause |
| `DEVRECORDER_RESUMED` | Service Worker | Content Script | Notify tabs of resume |
| `DEVRECORDER_REMOVE_DRAWING` | Service Worker | Content Script | Remove overlay on stop |

**Page Agent ↔ Content Script (via window.postMessage):**

| Message source | Type | Direction |
|---|---|---|
| `devrecorder-page-agent` | `console` | Page → Content Script |
| `devrecorder-page-agent` | `network-response` | Page → Content Script |
| `devrecorder-control` | `start` / `stop` | Content Script → Page |

---

## Network Capture Pipeline

Network capture uses a two-layer system to get complete request/response data:

```
Layer 1: chrome.webRequest API (Service Worker)
├── onBeforeRequest     → requestBody (raw bytes / formData)
├── onSendHeaders       → requestHeaders (redacted)
├── onHeadersReceived   → responseHeaders (redacted)
├── onCompleted         → status, statusLine, duration
└── onErrorOccurred     → error info

Layer 2: Page Agent (Injected Script)
├── window.fetch override  → clones response, reads body text
└── XMLHttpRequest override → reads responseText on 'load'

Matching (in Service Worker):
  onCompleted fires → wait 500ms → findResponseBody()
  ├── Exact match: method + full URL
  ├── Pathname match: method + URL pathname
  └── Endswith match: method + URL ends with path
  If not found → retry at 1.5s → retry at 3.5s → give up

Result: Complete NetworkEventData with headers, body, response
```

**Why two layers?** `chrome.webRequest` doesn't provide response bodies. The page-agent can read response bodies by cloning `fetch` responses, but can't see request headers. Together they provide complete data.

---

## Video Recording Pipeline

```
getDisplayMedia (screen/window/tab)
  + optional getUserMedia (microphone)
  │
  ├─[Window mode]: record display stream directly
  ├─[Window + Mic]: mix audio via AudioContext
  └─[Region mode]: crop via canvas at 30fps + mix audio
  │
  ▼
MediaRecorder (WebM VP9+Opus, 2.5Mbps)
  → ondataavailable every 1s → chunks[]
  → Consolidate chunks every 30s (reduce blob count)
  │
  ▼
On Stop:
  → Merge all chunks into single Blob
  → fixWebmDuration() — patch EBML binary for seeking
  │
  ▼
Upload to Cloudflare R2:
  ├─[<10MB]: single presigned PUT
  └─[>10MB]: multipart upload (10MB chunks, 3 retries each)
  │
  ▼
RECORDING_SAVED → service worker updates duration
```

---

## Security & Privacy

### Header Redaction
The following headers are automatically redacted (replaced with `[REDACTED]`):
- `authorization`, `cookie`, `set-cookie`
- `x-api-key`, `x-auth-token`, `x-csrf-token`, `x-xsrf-token`
- `proxy-authorization`, `www-authenticate`
- `x-access-token`, `x-refresh-token`, `x-session-id`, `x-forwarded-for`

### Body Redaction
JSON request/response bodies have sensitive fields redacted:
- `password`, `passwd`, `secret`, `token`, `access_token`, `refresh_token`
- `api_key`, `apikey`, `api_secret`, `authorization`
- `credit_card`, `card_number`, `cvv`, `ssn`, `private_key`

### Zero Overhead When Idle
- Page agent does nothing when `active = false` (all interception short-circuits)
- webRequest listeners only attached during recording
- Drawing overlay removed on stop
- No background polling or data collection when not recording

---

## Permissions

| Permission | Reason |
|---|---|
| `desktopCapture` | Screen recording via getDisplayMedia |
| `offscreen` | Create offscreen document for MediaRecorder |
| `storage` | Store auth token (local) and canvas state (session) |
| `webRequest` | Intercept network requests for headers/body |
| `webNavigation` | Track page navigations and SPA route changes |
| `activeTab` | Access current tab for recording |
| `tabs` | Query tab info, detect tab switches |
| `scripting` | Inject content scripts and page-agent |
| `alarms` | Keepalive timer to prevent service worker termination |
| `<all_urls>` | Capture network requests from any origin |

---

## Build & Development

### Prerequisites
- Node.js 18+
- npm

### Setup
```bash
cd extension
npm install
```

### Development (watch mode)
```bash
npm run dev
```
Builds to `dist/` with file watching. Load `dist/` as unpacked extension in `chrome://extensions`.

### Production Build
```bash
npm run build
```

### Type Check
```bash
npm run typecheck
```

### Publish (tag a release)
```bash
npm run publish
```
Creates a git tag `ext-v{version}` from manifest.json version and pushes it.

### Build Architecture
Vite builds 4 entry points in the main build:
- `popup.html` → React popup
- `viewer.html` → React viewer
- `offscreen.html` → Offscreen document
- `background/service-worker.ts` → Service worker

Content scripts are built separately as IIFE bundles (no ES module imports) via a custom Vite plugin, since content scripts cannot use ES modules in Chrome MV3.

### Loading the Extension
1. Run `npm run build`
2. Open `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" → select the `dist/` folder

---

## API Endpoints

Base URL: `https://www.devrecorder.com/api`

All requests include `Authorization: Bearer <token>` from `chrome.storage.local`.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/recordings` | Create a new recording |
| `PATCH` | `/recordings/:id` | Update recording (duration) |
| `GET` | `/recordings` | List all recordings |
| `GET` | `/recordings/:id` | Get single recording |
| `DELETE` | `/recordings/:id` | Delete a recording |
| `GET` | `/recordings/:id/events` | Get all events for a recording |
| `POST` | `/recordings/events/bulk` | Send batched events |
| `POST` | `/recordings/:id/upload-url` | Get presigned upload URL (<10MB) |
| `POST` | `/recordings/:id/confirm-upload` | Confirm simple upload |
| `POST` | `/recordings/:id/multipart/start` | Start multipart upload |
| `POST` | `/recordings/:id/multipart/part-url` | Get presigned part URL |
| `POST` | `/recordings/:id/multipart/complete` | Complete multipart upload |
